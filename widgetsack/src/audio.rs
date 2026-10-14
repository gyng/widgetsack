//! Audio spectrum source: capture the system output via WASAPI loopback, run a real-input FFT,
//! and stream a small per-frame band array to the webview over a Tauri `Channel` — the data
//! backing the `spectrum` widget (a canvas visualiser).
//!
//! Why a `Channel` and not the `telemetry` event: a spectrum is ~32–128 floats at up to 60 Hz,
//! whereas telemetry is scalar samples at 1 Hz and the hub collapses a series to its last value
//! (`appendSample` in `core/telemetry.ts`). Tauri's event system is documented as "not designed
//! for low latency or high throughput"; `Channel<T>` is the streaming transport. One channel per
//! (window, device + scale) stream; one capture runs per distinct output device (bounded by
//! `MAX_CAPTURES`) and fans each frame out to its subscribers, binned to each one's scale.
//!
//! Ring layout (concentric architecture, AGENTS.md §5):
//! - DSP is **pure seams** (`hann_window`, `downmix_mono`, `magnitudes`, `to_bands`, `smooth`,
//!   `rms`, `log_band_edges`, `normalize_db`) + `SpectrumProcessor` — no I/O, unit-tested below,
//!   and cross-platform (only `realfft`).
//! - WASAPI is the outer adapter, kept behind `cfg(target_os = "windows")` (anti-corruption layer,
//!   like `listener.rs` for gsmtc). Capture runs on a dedicated OS thread that initialises COM in
//!   the MTA itself — the documented fix for the "stream opens but no buffers arrive" COM-apartment
//!   collision when audio capture coexists with the Tauri/winit runtime.
//!
//! Bridge contract: `SpectrumFrame` mirrors `SpectrumFrame` in `client/src/lib/audio/source.ts`.
//! Command names (`start_spectrum`, `stop_spectrum`) must match the frontend.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};
use serde::Serialize;
use tauri::Runtime;
use tauri::ipc::Channel;

use crate::log;

// --- Capture / analysis parameters -------------------------------------------------------------

/// Requested capture format. WASAPI shared-mode loopback delivers the render endpoint's mix format
/// (usually 32-bit float), but `autoconvert: true` makes the audio engine resample/convert to this
/// format for us — so the capture loop can always assume interleaved f32 at this rate/channel count
/// and never has to branch on the device's native `SampleType` (the classic loopback gotcha).
const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
/// FFT window size. 2048 @ 48 kHz ≈ 23 ms / ≈23 Hz per bin — the common sweet spot for a 30–60 fps
/// visualiser (responsive, enough low-end resolution). A power of two keeps rustfft fast.
const FFT_SIZE: usize = 2048;
/// Fallback band count if `start_spectrum` is called without `bands`. In practice the frontend
/// always provides it (`CAPTURE_BANDS` in `source.ts`); this is just a sane default for safety.
const DEFAULT_BANDS: usize = 64;
const MIN_BANDS: usize = 8;
const MAX_BANDS: usize = 256;
/// Log-frequency band range. Below ~30 Hz is sub-audible rumble; cap the top well under Nyquist
/// (24 kHz) where music has little energy, so the bars spend their resolution where sound lives.
const FMIN_HZ: f32 = 30.0;
const FMAX_HZ: f32 = 16_000.0;
/// Noise floor for the dB→0..1 mapping. Magnitudes quieter than this map to an empty bar.
const FLOOR_DB: f32 = -90.0;
/// Per-band envelope coefficients (0..1 fraction moved toward the new value each frame). Fast
/// attack so transients pop; slow release for the classic falling-bar decay.
const ATTACK: f32 = 0.7;
const RELEASE: f32 = 0.18;
/// RMS below this (≈ -80 dBFS) counts as silence — nothing is playing.
const SILENCE_RMS: f32 = 1.0e-4;
/// Frame cadence while audio is playing (~60 fps) and while silent (battery: a flat bar needn't
/// repaint 60×/s on a persistent overlay that is never "hidden"). Sound resumes within one active
/// tick because RMS is checked every active interval regardless.
const ACTIVE_INTERVAL_MS: u128 = 16;
const SILENT_INTERVAL_MS: u128 = 250;

/// An audio output (render) device the user can pick to visualise. Mirrors `AudioDevice` in
/// `client/src/lib/audio/source.ts`. `id` is the stable WASAPI endpoint id stored in the widget
/// config; `name` is the friendly label shown in the inspector dropdown.
#[derive(Clone, Debug, Serialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
}

/// One analysed frame sent to the webview. Mirrors `SpectrumFrame` in `client/src/lib/audio/source.ts`.
#[derive(Clone, Debug, Serialize)]
pub struct SpectrumFrame {
    /// Per-band magnitudes, already normalised to 0..1 (newest frame; bands are low→high frequency).
    pub bands: Vec<f32>,
    /// Broadband RMS level (0..1-ish) of the window — lets the frontend stop its rAF loop on silence.
    pub rms: f32,
    pub ts_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// --- Off-UI-thread COM calls ------------------------------------------------------------------
// Tauri runs a NON-async command on the main/UI thread. The Core Audio calls below are COM RPCs
// into the audio service (audiodg / the endpoint's device driver) — normally sub-millisecond, but
// during a device/monitor switch they can block for seconds, and the volume/switcher widgets poll
// them every 1–8 s. So every such command is `async`, runs its COM work on a blocking-pool thread,
// and gives up (returning an error / `None`) after `COM_CALL_BUDGET` so the UI thread and the IPC
// queue never wait on the audio stack.

/// How long a single Core Audio command may take before the caller is released with an error.
const COM_CALL_BUDGET: Duration = Duration::from_secs(2);

/// Core Audio calls still running (stuck ones included — a timed-out call can't be cancelled).
/// Past `COM_CALL_MAX_IN_FLIGHT` new calls fail fast instead of parking another pool thread behind
/// the same hung audio service: the widgets poll every 1–8 s, so a minutes-long stall would
/// otherwise accumulate dozens of blocked threads.
static COM_CALLS_IN_FLIGHT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
const COM_CALL_MAX_IN_FLIGHT: usize = 4;

/// Run `f` on the blocking pool with a hard `budget`. On timeout the blocking task keeps running
/// to completion on its pool thread (it cannot be cancelled) but the caller is released. `label`
/// names the command in the error/log line.
pub(crate) async fn com_call<T: Send + 'static>(
    label: &'static str,
    budget: Duration,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    use std::sync::atomic::Ordering;

    /// Decrements the in-flight count when the blocking closure finishes (or panics).
    struct InFlight;
    impl Drop for InFlight {
        fn drop(&mut self) {
            COM_CALLS_IN_FLIGHT.fetch_sub(1, Ordering::AcqRel);
        }
    }

    if COM_CALLS_IN_FLIGHT.fetch_add(1, Ordering::AcqRel) >= COM_CALL_MAX_IN_FLIGHT {
        COM_CALLS_IN_FLIGHT.fetch_sub(1, Ordering::AcqRel);
        return Err(format!(
            "{label}: audio stack busy ({COM_CALL_MAX_IN_FLIGHT} calls already outstanding)"
        ));
    }
    let task = tokio::task::spawn_blocking(move || {
        let _in_flight = InFlight;
        f()
    });
    match tokio::time::timeout(budget, task).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(join)) => Err(format!("{label}: worker failed: {join}")),
        Err(_) => {
            log::warn("audio", "Core Audio call timed out")
                .field("command", label)
                .field("budget_ms", budget.as_millis())
                .emit();
            Err(format!(
                "{label}: timed out after {} ms",
                budget.as_millis()
            ))
        }
    }
}

/// Initialise COM (MTA) on the CALLING thread, once per thread. The blocking pool recycles its
/// threads, so a per-call `CoInitializeEx` would keep bumping the apartment refcount; a thread-local
/// flag makes it exactly one init per pool thread (never uninitialised — the thread's lifetime is the
/// apartment's). `RPC_E_CHANGED_MODE` (COM already up in another mode) is harmless for these calls.
#[cfg(target_os = "windows")]
pub(crate) fn ensure_com_mta() {
    use std::cell::Cell;
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
    thread_local! {
        static COM_READY: Cell<bool> = const { Cell::new(false) };
    }
    COM_READY.with(|ready| {
        if !ready.get() {
            // SAFETY: plain COM apartment init; the result is deliberately ignored (see above).
            let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            ready.set(true);
        }
    });
}

// --- Pure DSP seams (unit-tested, no I/O) ------------------------------------------------------

/// A periodic Hann window of length `n` (0 at both ends, 1 in the middle). Reduces spectral
/// leakage before the FFT. `n <= 1` degenerates to all-ones.
fn hann_window(n: usize) -> Vec<f32> {
    if n <= 1 {
        return vec![1.0; n];
    }
    let denom = (n - 1) as f32;
    (0..n)
        .map(|i| {
            let x = std::f32::consts::TAU * i as f32 / denom;
            0.5 - 0.5 * x.cos()
        })
        .collect()
}

/// Whether a capture session tracks the system default output: nothing was chosen, or the chosen
/// device was unavailable and `open_render_device` fell back to the default. Pure.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn follows_default_device(chosen: Option<&str>, opened_id: &str) -> bool {
    chosen.is_none_or(|id| id.is_empty() || id != opened_id)
}

/// Average interleaved channels down to a mono signal. `channels <= 1` returns the input as-is.
/// A trailing partial frame (fewer than `channels` samples) is dropped.
fn downmix_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Root-mean-square level of a block of samples (0 for an empty block).
fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|x| x * x).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

/// Magnitude (|z|) of each complex bin.
fn magnitudes(spectrum: &[Complex<f32>]) -> Vec<f32> {
    spectrum.iter().map(|c| c.norm()).collect()
}

/// Map a raw bin magnitude to a 0..1 bar height via a dB scale. `reference` is the magnitude that
/// maps to 0 dB (full bar); anything at or below `floor_db` maps to 0. Linear in dB between.
fn normalize_db(magnitude: f32, reference: f32, floor_db: f32) -> f32 {
    if magnitude <= 0.0 || reference <= 0.0 {
        return 0.0;
    }
    let db = 20.0 * (magnitude / reference).log10();
    ((db - floor_db) / -floor_db).clamp(0.0, 1.0)
}

/// `band_count + 1` band edges spanning `[fmin, fmax]`. `linear` spreads them evenly in frequency;
/// otherwise they are geometrically (log) spaced — octave-even, which reads perceptually evenly and
/// is the musical default. A degenerate range also falls back to linear so callers always get a
/// monotonic edge list.
fn band_edges(band_count: usize, fmin: f32, fmax: f32, linear: bool) -> Vec<f32> {
    if band_count == 0 {
        return Vec::new();
    }
    if linear || fmin <= 0.0 || fmax <= fmin {
        let span = (fmax - fmin).max(0.0);
        return (0..=band_count)
            .map(|i| fmin + span * i as f32 / band_count as f32)
            .collect();
    }
    let ratio = (fmax / fmin).powf(1.0 / band_count as f32);
    (0..=band_count)
        .map(|i| fmin * ratio.powi(i as i32))
        .collect()
}

/// Group linear FFT-bin magnitudes into `band_count` display bands over [`FMIN_HZ`, `FMAX_HZ`]
/// (log- or `linear`-spaced), each the dB-normalised (0..1) PEAK magnitude within its frequency span.
/// Peak (not average) keeps narrow tones visible. The frequency range and dB floor are the fixed
/// app constants, so they aren't parameters.
fn to_bands(
    mags: &[f32],
    sample_rate: u32,
    fft_size: usize,
    band_count: usize,
    linear: bool,
) -> Vec<f32> {
    if band_count == 0 || mags.is_empty() || fft_size == 0 {
        return vec![0.0; band_count];
    }
    let nyquist = sample_rate as f32 / 2.0;
    let edges = band_edges(band_count, FMIN_HZ, FMAX_HZ.min(nyquist), linear);
    let bin_hz = sample_rate as f32 / fft_size as f32;
    // A full-scale sine through a Hann window peaks at ≈ N/4 (window coherent gain ≈ 0.5 × N/2).
    let reference = fft_size as f32 / 4.0;
    (0..band_count)
        .map(|b| {
            let lo_bin = (edges[b] / bin_hz).floor() as usize;
            // Each band spans at least one bin, even where bins are wider than the band (low end).
            let hi_bin = ((edges[b + 1] / bin_hz).ceil() as usize).max(lo_bin + 1);
            let mut peak = 0.0_f32;
            for &m in mags.iter().take(hi_bin.min(mags.len())).skip(lo_bin) {
                peak = peak.max(m);
            }
            normalize_db(peak, reference, FLOOR_DB)
        })
        .collect()
}

/// Per-band attack/release envelope: rise toward a louder value by `attack`, fall toward a quieter
/// one by `release` (both 0..1). `prev` and `next` must be the same length.
fn smooth(prev: &[f32], next: &[f32], attack: f32, release: f32) -> Vec<f32> {
    next.iter()
        .zip(prev.iter())
        .map(|(&n, &p)| {
            let coef = if n > p { attack } else { release };
            p + (n - p) * coef
        })
        .collect()
}

/// How a subscriber wants its bands binned: `(band_count, linear)`. Binning + smoothing are cheap
/// per-frame steps on top of ONE shared FFT, so subscribers of the same capture that differ only in
/// scale / band count share the capture and each get their own variant.
type FrameVariant = (usize, bool);

/// Stateful analyser: owns the reusable FFT plan, the window, scratch buffers and the smoothed
/// band state (one envelope per requested variant). `compute_frames` is the hot path — windows the
/// samples, runs ONE real FFT, then bins + smooths it once per variant. Pure given its inputs
/// (testable without audio hardware).
struct SpectrumProcessor {
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    input: Vec<f32>,
    spectrum: Vec<Complex<f32>>,
    smoothed: HashMap<FrameVariant, Vec<f32>>,
    sample_rate: u32,
    fft_size: usize,
}

impl SpectrumProcessor {
    fn new(sample_rate: u32, fft_size: usize) -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(fft_size);
        let input = fft.make_input_vec();
        let spectrum = fft.make_output_vec();
        SpectrumProcessor {
            fft,
            window: hann_window(fft_size),
            input,
            spectrum,
            smoothed: HashMap::new(),
            sample_rate,
            fft_size,
        }
    }

    /// Analyse the most recent `fft_size` samples into one `SpectrumFrame` per entry of `variants`
    /// (same order). `samples` may be shorter than `fft_size` (zero-padded); only the trailing window
    /// is used. `level` is the precomputed RMS. Envelope state for variants no longer requested is
    /// dropped, so a scale switch starts that variant from silence rather than a stale shape.
    fn compute_frames(
        &mut self,
        samples: &[f32],
        variants: &[FrameVariant],
        level: f32,
        ts_ms: u64,
    ) -> Vec<SpectrumFrame> {
        let start = samples.len().saturating_sub(self.fft_size);
        let window = &samples[start..];
        for (i, slot) in self.input.iter_mut().enumerate() {
            *slot = window.get(i).copied().unwrap_or(0.0) * self.window[i];
        }
        self.smoothed.retain(|v, _| variants.contains(v));
        // realfft uses `input` as scratch and writes N/2+1 complex bins into `spectrum`.
        let mags = self
            .fft
            .process(&mut self.input, &mut self.spectrum)
            .is_ok()
            .then(|| magnitudes(&self.spectrum));
        variants
            .iter()
            .map(|&(band_count, linear)| {
                let state = self
                    .smoothed
                    .entry((band_count, linear))
                    .or_insert_with(|| vec![0.0; band_count]);
                if let Some(mags) = &mags {
                    let bands = to_bands(mags, self.sample_rate, self.fft_size, band_count, linear);
                    *state = smooth(state, &bands, ATTACK, RELEASE);
                }
                SpectrumFrame {
                    bands: state.clone(),
                    rms: level,
                    ts_ms,
                }
            })
            .collect()
    }
}

// --- Shared state + lifecycle ------------------------------------------------------------------
// Captures are keyed by OUTPUT DEVICE (the WASAPI endpoint id; "" = follow the system default): one
// loopback thread per distinct device actually requested, each with its own subscriber set. Scale and
// band count are per SUBSCRIBER — they're cheap per-frame binning over the capture's one FFT — so two
// widgets on the same device with different scales share a capture. A subscriber is one
// (window label, frontend stream key) pair with its own `Channel`, so a window hosting two Spectrum
// widgets with different settings gets two independent streams.

/// Upper bound on concurrent loopback captures (threads + WASAPI clients + FFTs). A request for a
/// further device shares an existing capture instead (see `choose_capture`), with a logged warning.
const MAX_CAPTURES: usize = 4;

/// One stream consumer: its channel plus how it wants the bands binned.
struct Subscriber {
    channel: Channel<SpectrumFrame>,
    band_count: usize,
    linear: bool,
}

/// `(window label, frontend stream key)` — identifies one subscription across all captures.
type SubKey = (String, String);

/// One device's capture: its subscribers and the capture-thread liveness flag.
#[derive(Default)]
struct Capture {
    subscribers: HashMap<SubKey, Subscriber>,
    running: bool,
}

/// All captures, keyed by device id ("" = system default). A plain `std::sync::Mutex` guards it —
/// locks are brief and never held across the FFT or I/O.
#[derive(Default)]
struct SpectrumInner {
    captures: HashMap<String, Capture>,
}

/// Where `subscribe` placed a subscriber.
#[derive(Debug, PartialEq, Eq)]
struct Placement {
    /// The capture (device key) the subscriber joined.
    capture: String,
    /// The capture thread isn't running yet — the caller must spawn it (outside the lock).
    spawn: bool,
    /// The bound was hit and the subscriber shares another device's capture instead of its own.
    fell_back: bool,
}

/// Pick the capture for a subscriber wanting device `wanted`, given the devices that currently have
/// subscribers (`live`). Join the matching capture, else open a new one while under `max`; at the
/// bound, share the closest live capture — the system default if one is live (a missing chosen
/// device falls back to the default anyway), else the first by id for determinism. Returns
/// `(capture key, fell_back)`. Pure.
fn choose_capture(live: &[&str], wanted: &str, max: usize) -> (String, bool) {
    if live.contains(&wanted) || live.len() < max {
        return (wanted.to_string(), false);
    }
    let shared = if live.contains(&"") {
        ""
    } else {
        live.iter().min().copied().unwrap_or(wanted)
    };
    (shared.to_string(), shared != wanted)
}

/// The distinct binning variants a capture's subscribers need this frame (sorted, deduplicated).
fn frame_variants<'a>(subscribers: impl Iterator<Item = &'a Subscriber>) -> Vec<FrameVariant> {
    let mut variants: Vec<FrameVariant> = subscribers
        .map(|s| (s.band_count.clamp(MIN_BANDS, MAX_BANDS), s.linear))
        .collect();
    variants.sort_unstable();
    variants.dedup();
    variants
}

impl SpectrumInner {
    /// Register (or replace) subscription `sub_key` on the capture for `device` ("" = default),
    /// honouring `MAX_CAPTURES`. Marks a non-running capture as running and reports `spawn`, so the
    /// caller starts exactly one thread for it.
    fn subscribe(&mut self, sub_key: SubKey, device: &str, sub: Subscriber) -> Placement {
        // A re-subscribe (watchdog restart / reload) replaces the old placement wherever it was.
        self.unsubscribe(&sub_key.0, Some(&sub_key.1));
        let live: Vec<&str> = self
            .captures
            .iter()
            .filter(|(_, c)| !c.subscribers.is_empty())
            .map(|(k, _)| k.as_str())
            .collect();
        let (key, fell_back) = choose_capture(&live, device, MAX_CAPTURES);
        let capture = self.captures.entry(key.clone()).or_default();
        capture.subscribers.insert(sub_key, sub);
        let spawn = !capture.running;
        capture.running = true;
        Placement {
            capture: key,
            spawn,
            fell_back,
        }
    }

    /// Drop window `label`'s subscription `key` (or ALL its subscriptions when `key` is `None`) from
    /// every capture. A running capture left empty exits on its own (its thread checks every frame);
    /// a stopped one is pruned here. Returns whether anything was removed.
    fn unsubscribe(&mut self, label: &str, key: Option<&str>) -> bool {
        let mut removed = false;
        for capture in self.captures.values_mut() {
            let before = capture.subscribers.len();
            capture
                .subscribers
                .retain(|(l, k), _| l != label || key.is_some_and(|key| key != k));
            removed |= capture.subscribers.len() != before;
        }
        self.captures
            .retain(|_, c| c.running || !c.subscribers.is_empty());
        removed
    }

    /// Capture-thread exit check for `device`, done atomically under the lock: when it has no
    /// subscribers, remove the entry (so a racing `subscribe` either joined before this — and the
    /// thread keeps going — or lands after and spawns a fresh thread) and return `true`.
    fn retire_if_idle(&mut self, device: &str) -> bool {
        match self.captures.get(device) {
            Some(c) if !c.subscribers.is_empty() => false,
            _ => {
                self.captures.remove(device);
                true
            }
        }
    }

    /// A capture thread is gone without retiring (spawn failure / gave up): clear its flag so a later
    /// `subscribe` respawns it, and prune the entry if nobody is waiting on it.
    fn mark_stopped(&mut self, device: &str) {
        if let Some(c) = self.captures.get_mut(device) {
            c.running = false;
            if c.subscribers.is_empty() {
                self.captures.remove(device);
            }
        }
    }
}

/// Managed Tauri state shared with the capture threads via the inner `Arc`.
#[derive(Default, Clone)]
pub struct SpectrumState(Arc<Mutex<SpectrumInner>>);

impl SpectrumState {
    fn lock(&self) -> std::sync::MutexGuard<'_, SpectrumInner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Start (or join) a spectrum stream for the calling window. `key` names this stream within the
/// window (the frontend keys it by device + scale, one `Channel` per key); a repeat call with the same
/// key replaces its channel (e.g. after a reload / watchdog restart). `device` picks the output
/// endpoint ("" / omitted = system default), `scale` is "log" | "linear", `bands` the band count.
/// Joins the capture already running for that device, or spawns one (bounded by `MAX_CAPTURES`).
#[tauri::command]
pub fn start_spectrum<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, SpectrumState>,
    channel: Channel<SpectrumFrame>,
    bands: Option<usize>,
    device: Option<String>,
    scale: Option<String>,
    key: Option<String>,
) -> Result<(), String> {
    let device = device.unwrap_or_default();
    let sub = Subscriber {
        channel,
        band_count: bands.unwrap_or(DEFAULT_BANDS).clamp(MIN_BANDS, MAX_BANDS),
        linear: matches!(scale.as_deref(), Some("linear")),
    };
    let sub_key = (window.label().to_string(), key.unwrap_or_default());
    let placement = state.lock().subscribe(sub_key, &device, sub);
    if placement.fell_back {
        log::warn(
            "audio",
            "spectrum: capture limit reached; sharing another device's capture",
        )
        .field("wanted", &device)
        .field("using", &placement.capture)
        .field("max", MAX_CAPTURES)
        .emit();
    }
    if placement.spawn {
        spawn_capture((*state).clone(), placement.capture);
    }
    Ok(())
}

/// Stop the calling window's spectrum stream `key` (every stream of the window when omitted — the
/// unload path). A capture whose last subscriber left exits on its own.
#[tauri::command]
pub fn stop_spectrum<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, SpectrumState>,
    key: Option<String>,
) -> Result<(), String> {
    state.lock().unsubscribe(window.label(), key.as_deref());
    Ok(())
}

/// Drop a destroyed window's subscriptions (called from the `WindowEvent::Destroyed` handler). A
/// window that goes away never calls `stop_spectrum`, and its `Channel` doesn't error on `send`
/// promptly enough to rely on — so a capture thread would keep the WASAPI loopback + FFT running for
/// a consumer that no longer exists. Removing them lets each thread exit once no window is left
/// (`run_capture` checks its subscriber set every frame). Unknown labels are a no-op.
pub fn forget_window(state: &SpectrumState, label: &str) {
    if state.lock().unsubscribe(label, None) {
        log::debug("audio", "spectrum: forgot destroyed window")
            .field("window", label)
            .emit();
    }
}

/// List the system's audio OUTPUT (render) endpoints, so the inspector can offer a device picker.
/// An empty selection means "system default". Windows-only; elsewhere there is no loopback backend
/// so the list is empty (the meter just shows nothing). Runs off the UI thread with a budget
/// (`com_call`) — polled by the switcher widget.
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn list_audio_outputs() -> Result<Vec<AudioDevice>, String> {
    com_call("list_audio_outputs", COM_CALL_BUDGET, enumerate_outputs).await?
}

#[cfg(target_os = "windows")]
fn enumerate_outputs() -> Result<Vec<AudioDevice>, String> {
    use wasapi::Direction;
    // The pool thread may be COM-uninitialised; init MTA once (enumeration works either way).
    ensure_com_mta();
    let enumerator = wasapi::DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let collection = enumerator
        .get_device_collection(&Direction::Render)
        .map_err(|e| e.to_string())?;
    let count = collection.get_nbr_devices().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for i in 0..count {
        if let Ok(device) = collection.get_device_at_index(i)
            && let (Ok(id), Ok(name)) = (device.get_id(), device.get_friendlyname())
        {
            out.push(AudioDevice { id, name });
        }
    }
    Ok(out)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn list_audio_outputs() -> Result<Vec<AudioDevice>, String> {
    Ok(Vec::new())
}

// --- Default output-device control (the Audio Switcher widget) ----------------------------------
// Reading the current default uses the documented wasapi enumerator; SETTING it uses the
// undocumented-but-stable IPolicyConfig COM interface (CPolicyConfigClient) — the same mechanism
// nircmd / SoundSwitch use, because Windows exposes no public API to set the default endpoint.

/// The current default RENDER endpoint's WASAPI id, so the switcher can mark the active device.
/// `None` on failure / timeout / non-Windows.
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn default_audio_output() -> Option<String> {
    com_call("default_audio_output", COM_CALL_BUDGET, read_default_output)
        .await
        .ok()
        .flatten()
}

#[cfg(target_os = "windows")]
fn read_default_output() -> Option<String> {
    use wasapi::Direction;
    ensure_com_mta();
    let enumerator = wasapi::DeviceEnumerator::new().ok()?;
    enumerator
        .get_default_device(&Direction::Render)
        .ok()?
        .get_id()
        .ok()
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn default_audio_output() -> Option<String> {
    None
}

/// IPolicyConfig — the undocumented endpoint-policy COM interface. Only `set_default_endpoint` is
/// used; the methods before it are declared as opaque slots SOLELY to preserve the vtable layout
/// (COM dispatch is by ordinal, so every earlier method must occupy its slot). IID + CLSID are the
/// long-stable CPolicyConfigClient values.
#[cfg(target_os = "windows")]
#[windows::core::interface("f8679f50-850a-41cf-9c72-430f290290c8")]
unsafe trait IPolicyConfig: windows::core::IUnknown {
    unsafe fn get_mix_format(
        &self,
        id: windows::core::PCWSTR,
        fmt: *mut *mut ::core::ffi::c_void,
    ) -> windows::core::HRESULT;
    unsafe fn get_device_format(
        &self,
        id: windows::core::PCWSTR,
        default: i32,
        fmt: *mut *mut ::core::ffi::c_void,
    ) -> windows::core::HRESULT;
    unsafe fn reset_device_format(&self, id: windows::core::PCWSTR) -> windows::core::HRESULT;
    unsafe fn set_device_format(
        &self,
        id: windows::core::PCWSTR,
        endpoint_fmt: *mut ::core::ffi::c_void,
        mix_fmt: *mut ::core::ffi::c_void,
    ) -> windows::core::HRESULT;
    unsafe fn get_processing_period(
        &self,
        id: windows::core::PCWSTR,
        default: i32,
        default_period: *mut i64,
        min_period: *mut i64,
    ) -> windows::core::HRESULT;
    unsafe fn set_processing_period(
        &self,
        id: windows::core::PCWSTR,
        period: *mut i64,
    ) -> windows::core::HRESULT;
    unsafe fn get_share_mode(
        &self,
        id: windows::core::PCWSTR,
        mode: *mut ::core::ffi::c_void,
    ) -> windows::core::HRESULT;
    unsafe fn set_share_mode(
        &self,
        id: windows::core::PCWSTR,
        mode: *mut ::core::ffi::c_void,
    ) -> windows::core::HRESULT;
    unsafe fn get_property_value(
        &self,
        id: windows::core::PCWSTR,
        key: i32,
        value: *const ::core::ffi::c_void,
        out: *mut ::core::ffi::c_void,
    ) -> windows::core::HRESULT;
    unsafe fn set_property_value(
        &self,
        id: windows::core::PCWSTR,
        key: i32,
        value: *const ::core::ffi::c_void,
        out: *mut ::core::ffi::c_void,
    ) -> windows::core::HRESULT;
    /// SetDefaultEndpoint(wszDeviceId, eRole) — the one we call. role: 0 eConsole, 1 eMultimedia, 2 eCommunications.
    unsafe fn set_default_endpoint(
        &self,
        device_id: windows::core::PCWSTR,
        role: u32,
    ) -> windows::core::HRESULT;
    unsafe fn set_endpoint_visibility(
        &self,
        id: windows::core::PCWSTR,
        visible: i32,
    ) -> windows::core::HRESULT;
}

/// Make `id` the default render endpoint for ALL roles (console + multimedia + communications), like
/// the Sound control panel's "Set Default". Callable from any window (it's a widget action, not a
/// studio-only setting). No-op error off Windows.
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn set_default_audio_output(id: String) -> Result<(), String> {
    if id.is_empty() {
        return Err("empty device id".into());
    }
    com_call("set_default_audio_output", COM_CALL_BUDGET, move || {
        write_default_output(&id)
    })
    .await?
}

#[cfg(target_os = "windows")]
fn write_default_output(id: &str) -> Result<(), String> {
    use std::iter::once;
    use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};
    use windows::core::PCWSTR;

    // CPolicyConfigClient.
    const CLSID_POLICY_CONFIG: windows::core::GUID =
        windows::core::GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

    // SAFETY: standard COM create-and-call; the device id is a NUL-terminated UTF-16 string that
    // outlives the calls. IPolicyConfig's vtable layout is preserved (see the interface decl).
    unsafe {
        // The pool thread may be COM-uninitialised; init MTA once.
        ensure_com_mta();
        let config: IPolicyConfig =
            CoCreateInstance(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let wide: Vec<u16> = id.encode_utf16().chain(once(0)).collect();
        for role in [0u32, 1, 2] {
            config
                .set_default_endpoint(PCWSTR(wide.as_ptr()), role)
                .ok()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn set_default_audio_output(_id: String) -> Result<(), String> {
    Err("setting the default audio output is only supported on Windows".into())
}

// --- System master volume + mute (the Volume widget) --------------------------------------------
// The documented Core Audio path: MMDeviceEnumerator → default render endpoint → IAudioEndpointVolume
// (scalar 0..1 master level + mute). Callable from any window (a widget control, not a studio setting).

/// The default render endpoint's master volume + mute. Mirrors `AudioVolume` in
/// `client/src/lib/audio/volume.ts`. camelCase on the wire.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct AudioVolume {
    /// Master level, 0.0..=1.0 (scalar — perceptually even, matching the Windows volume slider).
    pub level: f32,
    pub muted: bool,
}

/// Acquire a render endpoint's `IAudioEndpointVolume`: the device with MMDevice id `device` (an id
/// from `list_audio_outputs`), or the default render endpoint when `device` is empty. A saved id
/// that no longer resolves (the output was unplugged / re-enumerated) falls back to the default
/// endpoint with a warning, so a paired volume still applies instead of silently failing. COM is
/// initialised MTA on the calling (pool) thread; `RPC_E_CHANGED_MODE` if already up in another mode
/// is harmless.
#[cfg(target_os = "windows")]
fn endpoint_volume(
    device: &str,
) -> windows::core::Result<windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume> {
    use std::iter::once;
    use windows::Win32::Media::Audio::{
        IMMDeviceEnumerator, MMDeviceEnumerator, eConsole, eRender,
    };
    use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};
    use windows::core::PCWSTR;

    // SAFETY: standard COM create/activate; every interface is released on drop. The id is a
    // NUL-terminated UTF-16 string that outlives the GetDevice call.
    unsafe {
        ensure_com_mta();
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let endpoint = if device.is_empty() {
            enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?
        } else {
            let wide: Vec<u16> = device.encode_utf16().chain(once(0)).collect();
            match enumerator.GetDevice(PCWSTR(wide.as_ptr())) {
                Ok(d) => d,
                Err(err) => {
                    log::warn(
                        "audio",
                        "output device not found; using the default endpoint",
                    )
                    .field("device", device)
                    .field("error", err)
                    .emit();
                    enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?
                }
            }
        };
        endpoint.Activate(CLSCTX_ALL, None)
    }
}

/// Read the system master volume + mute. `None` on failure / timeout / non-Windows. Polled every
/// second by the volume widget, so it MUST never block the UI thread (`com_call`).
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn get_audio_volume() -> Option<AudioVolume> {
    com_call("get_audio_volume", COM_CALL_BUDGET, read_volume)
        .await
        .ok()
        .flatten()
}

#[cfg(target_os = "windows")]
fn read_volume() -> Option<AudioVolume> {
    // SAFETY: standard Core Audio read; all interfaces are released on drop.
    unsafe {
        let vol = endpoint_volume("").ok()?;
        let level = vol.GetMasterVolumeLevelScalar().ok()?;
        let muted = vol.GetMute().ok()?.as_bool();
        Some(AudioVolume { level, muted })
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn get_audio_volume() -> Option<AudioVolume> {
    None
}

/// Set a render endpoint's master volume (scalar 0..1, clamped): the output with MMDevice id
/// `device` (from `list_audio_outputs`), or the current default output when `device` is empty /
/// omitted. No-op error off Windows.
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn set_audio_volume(level: f32, device: Option<String>) -> Result<(), String> {
    let device = device.unwrap_or_default();
    com_call("set_audio_volume", COM_CALL_BUDGET, move || {
        // SAFETY: writes the master scalar level; eventcontext is null (no callback correlation needed).
        unsafe {
            let vol = endpoint_volume(&device).map_err(|e| e.to_string())?;
            vol.SetMasterVolumeLevelScalar(level.clamp(0.0, 1.0), std::ptr::null())
                .map_err(|e| e.to_string())
        }
    })
    .await?
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn set_audio_volume(_level: f32, _device: Option<String>) -> Result<(), String> {
    Err("setting the volume is only supported on Windows".into())
}

/// Set the system mute state. No-op error off Windows.
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn set_audio_mute(muted: bool) -> Result<(), String> {
    com_call("set_audio_mute", COM_CALL_BUDGET, move || {
        // SAFETY: writes the mute flag; eventcontext is null.
        unsafe {
            let vol = endpoint_volume("").map_err(|e| e.to_string())?;
            vol.SetMute(muted, std::ptr::null())
                .map_err(|e| e.to_string())
        }
    })
    .await?
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn set_audio_mute(_muted: bool) -> Result<(), String> {
    Err("muting is only supported on Windows".into())
}

/// Spawn the dedicated capture thread for `device` (Windows only; elsewhere there is no loopback
/// backend, so clear the flag immediately so the state doesn't claim to be running).
#[cfg(target_os = "windows")]
fn spawn_capture(state: SpectrumState, device: String) {
    let thread_state = state.clone();
    let thread_device = device.clone();
    if let Err(err) = std::thread::Builder::new()
        .name("spectrum-capture".to_string())
        .spawn(move || run_capture(&thread_state, &thread_device))
    {
        // No thread will ever clear `running`: do it here so a later `start_spectrum` retries.
        state.lock().mark_stopped(&device);
        log::warn("audio", "spectrum: capture thread spawn failed")
            .field("error", err)
            .emit();
    }
}

#[cfg(not(target_os = "windows"))]
fn spawn_capture(state: SpectrumState, device: String) {
    state.lock().mark_stopped(&device);
}

// --- WASAPI loopback capture (Windows adapter) -------------------------------------------------

#[cfg(target_os = "windows")]
mod capture {
    use super::*;
    use std::collections::VecDeque;
    use std::time::{Duration, Instant};
    use wasapi::{Direction, SampleType, StreamMode, WaveFormat, initialize_mta};

    /// How long to wait before re-initialising after a recoverable device error / switch.
    const RETRY_BACKOFF: Duration = Duration::from_millis(500);
    /// Give up (and let a later `start_spectrum` respawn) after this many consecutive sessions that
    /// never delivered a frame — so a persistently broken device can't spin this thread forever.
    const MAX_CONSECUTIVE_FAILURES: u32 = 10;

    /// Why a single stream session ended, so the outer loop knows whether to give up or re-init.
    enum SessionEnd {
        /// Every window unsubscribed.
        NoSubscribers,
        /// The device dropped / format changed / the user switched outputs. `emitted` is whether the
        /// session sent at least one frame — a session that never emits counts toward the bound.
        DeviceLost { emitted: bool },
    }

    /// Capture-thread entry point. Initialises COM in the MTA on THIS thread (the documented fix
    /// for loopback "opens but never delivers" apartment collisions), then runs stream sessions
    /// until no window is subscribed, re-initialising across device changes so a set-and-forget
    /// overlay's spectrum survives the user switching outputs. Clears `running` on the way out.
    pub(super) fn run_capture(state: &SpectrumState, device: &str) {
        // MTA init can legitimately fail with RPC_E_CHANGED_MODE if COM was already initialised on
        // this thread in another mode; treat only a hard failure as fatal.
        if let Err(err) = initialize_mta().ok() {
            log::warn("audio", "spectrum: COM init failed")
                .field("error", err)
                .emit();
        }

        let mut failures: u32 = 0;
        loop {
            // Atomic stop: clear `running` ONLY while holding the lock AND confirming no subscribers,
            // so a `start_spectrum` racing in either keeps this thread alive (it observes a non-empty
            // set) or — if it lands after the flag is cleared — spawns a fresh thread. This closes the
            // window where a thread could exit just as a new window registered, orphaning its channel.
            if state.lock().retire_if_idle(device) {
                return;
            }

            match run_session(state, device) {
                // Re-checked atomically at the loop top (a window may have unsubscribed, or raced in).
                Ok(SessionEnd::NoSubscribers) => failures = 0,
                Ok(SessionEnd::DeviceLost { emitted }) => {
                    failures = if emitted { 0 } else { failures + 1 };
                }
                Err(err) => {
                    log::warn("audio", "spectrum: capture session error")
                        .field("error", err)
                        .emit();
                    failures += 1;
                }
            }
            if failures >= MAX_CONSECUTIVE_FAILURES {
                log::error(
                    "audio",
                    "spectrum: giving up after repeated capture failures",
                )
                .field("device", device)
                .emit();
                state.lock().mark_stopped(device);
                return;
            }
            if failures > 0 {
                std::thread::sleep(RETRY_BACKOFF);
            }
        }
    }

    /// How often a session that follows the system default re-checks which endpoint that is.
    const DEFAULT_DEVICE_CHECK: Duration = Duration::from_secs(1);

    /// Resolve the render device to capture: the one whose WASAPI id matches `wanted`, else the
    /// system default (covers an unplugged / renamed device — fall back rather than fail).
    fn open_render_device(
        enumerator: &wasapi::DeviceEnumerator,
        wanted: Option<&str>,
    ) -> Result<wasapi::Device, Box<dyn std::error::Error>> {
        if let Some(id) = wanted.filter(|s| !s.is_empty()) {
            let collection = enumerator.get_device_collection(&Direction::Render)?;
            let count = collection.get_nbr_devices()?;
            for i in 0..count {
                if let Ok(device) = collection.get_device_at_index(i)
                    && device.get_id().map(|d| d == id).unwrap_or(false)
                {
                    return Ok(device);
                }
            }
        }
        Ok(enumerator.get_default_device(&Direction::Render)?)
    }

    /// One capture session against `capture_device` (a WASAPI endpoint id, or "" for the system
    /// default) — the key of this thread's capture, fixed for the thread's life. Returns when its
    /// subscribers drop (NoSubscribers) or a recoverable device error / default switch occurs
    /// (DeviceLost).
    fn run_session(
        state: &SpectrumState,
        capture_device: &str,
    ) -> Result<SessionEnd, Box<dyn std::error::Error>> {
        let enumerator = wasapi::DeviceEnumerator::new()?;
        let session_device = Some(capture_device).filter(|d| !d.is_empty());
        // Loopback = the RENDER endpoint (speakers) opened as a CAPTURE client (wasapi sets
        // AUDCLNT_STREAMFLAGS_LOOPBACK for the Render-device + Capture-direction + Shared combo).
        let device = open_render_device(&enumerator, session_device)?;
        let device_name = device
            .get_friendlyname()
            .unwrap_or_else(|_| "unknown".to_string());
        // Following the system default (nothing chosen, or the chosen device is gone): Windows can
        // switch the default to a headset while the old endpoint stays alive but silent, so the
        // session must notice and re-open on the new default.
        let opened_id = device.get_id().unwrap_or_default();
        let follows_default = follows_default_device(session_device, &opened_id);
        let mut default_checked = Instant::now();
        let mut audio_client = device.get_iaudioclient()?;

        let format = WaveFormat::new(
            32,
            32,
            &SampleType::Float,
            SAMPLE_RATE as usize,
            CHANNELS as usize,
            None,
        );
        let (_default_period, min_period) = audio_client.get_device_period()?;
        // Polling (not event-driven): loopback is incompatible with EVENTCALLBACK in shared mode.
        let mode = StreamMode::PollingShared {
            autoconvert: true,
            buffer_duration_hns: min_period,
        };
        audio_client.initialize_client(&format, &Direction::Capture, &mode)?;

        let block_align = format.get_blockalign() as usize;
        let n_channels = format.get_nchannels() as usize;
        let capture_client = audio_client.get_audiocaptureclient()?;
        audio_client.start_stream()?;
        log::info("audio", "spectrum: capture session started")
            .field("device", &device_name)
            .emit();

        let mut processor = SpectrumProcessor::new(SAMPLE_RATE, FFT_SIZE);
        let mut byte_queue: VecDeque<u8> = VecDeque::new();
        // Keep a little more than one window so `compute_frames` always has a full FFT_SIZE.
        let mut mono: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);
        let cap = FFT_SIZE * 2;

        let poll = Duration::from_millis(4);
        let mut last_emit = Instant::now();
        let mut first = true;
        // Whether this session has delivered ≥1 frame — gates the failure bound in run_capture.
        let mut emitted = false;

        loop {
            if let Err(err) = capture_client.read_from_device_to_deque(&mut byte_queue) {
                log::warn("audio", "spectrum: read failed (device lost?)")
                    .field("error", err)
                    .emit();
                let _ = audio_client.stop_stream();
                return Ok(SessionEnd::DeviceLost { emitted });
            }

            // Drain whole frames → interleaved f32 → mono. autoconvert guarantees the bytes are
            // little-endian f32 in `n_channels`-sample frames, so `downmix_mono` (the tested seam)
            // averages each frame down to one sample.
            let whole_bytes = (byte_queue.len() / block_align) * block_align;
            if whole_bytes >= 4 {
                let mut interleaved = Vec::with_capacity(whole_bytes / 4);
                for _ in 0..whole_bytes / 4 {
                    let b = [
                        byte_queue.pop_front().unwrap_or(0),
                        byte_queue.pop_front().unwrap_or(0),
                        byte_queue.pop_front().unwrap_or(0),
                        byte_queue.pop_front().unwrap_or(0),
                    ];
                    interleaved.push(f32::from_le_bytes(b));
                }
                mono.extend(downmix_mono(&interleaved, n_channels));
            }
            if mono.len() > cap {
                mono.drain(0..mono.len() - cap);
            }

            // Emit on the cadence REGARDLESS of how full `mono` is: WASAPI loopback delivers no data
            // while the render device is idle, so gating on a full FFT window would mean NO frames at
            // all — a frozen/blank widget. compute_frames zero-pads a short buffer, so an idle stream
            // just emits flat frames (throttled to SILENT_INTERVAL_MS), and the bars come alive the
            // instant audio plays.
            let elapsed = last_emit.elapsed().as_millis();
            if first || elapsed >= ACTIVE_INTERVAL_MS {
                let start = mono.len().saturating_sub(FFT_SIZE);
                let level = rms(&mono[start..]);
                let silent = level < SILENCE_RMS;
                if first || !silent || elapsed >= SILENT_INTERVAL_MS {
                    first = false;
                    last_emit = Instant::now();
                    // Each subscriber's band count + scale are read live (per frame), so an inspector
                    // change — or a new subscriber with another scale — applies without a re-init.
                    let variants = match state.lock().captures.get(capture_device) {
                        Some(c) if !c.subscribers.is_empty() => {
                            frame_variants(c.subscribers.values())
                        }
                        _ => {
                            let _ = audio_client.stop_stream();
                            return Ok(SessionEnd::NoSubscribers);
                        }
                    };
                    // Outside the lock: a COM call that can stall during a device switch.
                    if follows_default && default_checked.elapsed() >= DEFAULT_DEVICE_CHECK {
                        default_checked = Instant::now();
                        let current = enumerator
                            .get_default_device(&Direction::Render)
                            .and_then(|d| d.get_id())
                            .unwrap_or_default();
                        if !current.is_empty() && current != opened_id {
                            log::info("audio", "spectrum: default output changed").emit();
                            let _ = audio_client.stop_stream();
                            return Ok(SessionEnd::DeviceLost { emitted });
                        }
                    }
                    let frames = processor.compute_frames(&mono, &variants, level, now_ms());

                    let mut inner = state.lock();
                    let Some(capture) = inner.captures.get_mut(capture_device) else {
                        drop(inner);
                        let _ = audio_client.stop_stream();
                        return Ok(SessionEnd::NoSubscribers);
                    };
                    // A subscriber whose variant appeared since `variants` was read waits a frame.
                    capture.subscribers.retain(|_, sub| {
                        let variant = (sub.band_count.clamp(MIN_BANDS, MAX_BANDS), sub.linear);
                        match variants.iter().position(|v| *v == variant) {
                            Some(i) => sub.channel.send(frames[i].clone()).is_ok(),
                            None => true,
                        }
                    });
                    if capture.subscribers.is_empty() {
                        drop(inner);
                        let _ = audio_client.stop_stream();
                        return Ok(SessionEnd::NoSubscribers);
                    }
                    emitted = true;
                }
            }

            std::thread::sleep(poll);
        }
    }
}

#[cfg(target_os = "windows")]
use capture::run_capture;

#[cfg(test)]
mod tests {
    use super::*;
    use realfft::num_complex::Complex;

    #[test]
    fn hann_window_is_zero_at_ends_and_peaks_in_the_middle() {
        let w = hann_window(8);
        assert_eq!(w.len(), 8);
        assert!(w[0].abs() < 1e-6, "starts at 0, got {}", w[0]);
        assert!(w[7].abs() < 1e-6, "ends at 0, got {}", w[7]);
        let mid = w.iter().cloned().fold(0.0_f32, f32::max);
        assert!(mid > 0.9, "peaks near 1, got {mid}");
        // Degenerate sizes don't panic.
        assert_eq!(hann_window(0), Vec::<f32>::new());
        assert_eq!(hann_window(1), vec![1.0]);
    }

    #[test]
    fn sessions_follow_the_default_unless_the_chosen_device_opened() {
        assert!(follows_default_device(None, "{speakers}"));
        assert!(follows_default_device(Some(""), "{speakers}"));
        // The chosen headset is unplugged: the session fell back to the default.
        assert!(follows_default_device(Some("{headset}"), "{speakers}"));
        assert!(!follows_default_device(Some("{headset}"), "{headset}"));
    }

    #[test]
    fn downmix_mono_averages_channels() {
        // Stereo: [L0,R0, L1,R1] → [(L0+R0)/2, (L1+R1)/2].
        assert_eq!(downmix_mono(&[1.0, 3.0, 2.0, 4.0], 2), vec![2.0, 3.0]);
        // Mono passthrough.
        assert_eq!(downmix_mono(&[0.5, -0.5], 1), vec![0.5, -0.5]);
        // Trailing partial frame is dropped.
        assert_eq!(downmix_mono(&[1.0, 1.0, 9.0], 2), vec![1.0]);
    }

    #[test]
    fn rms_of_known_block() {
        assert_eq!(rms(&[]), 0.0);
        assert_eq!(rms(&[0.0, 0.0, 0.0]), 0.0);
        // RMS of [3,4] = sqrt((9+16)/2) = sqrt(12.5).
        assert!((rms(&[3.0, 4.0]) - 12.5_f32.sqrt()).abs() < 1e-5);
    }

    #[test]
    fn normalize_db_maps_floor_to_zero_and_reference_to_one() {
        assert_eq!(normalize_db(0.0, 100.0, -90.0), 0.0);
        assert!((normalize_db(100.0, 100.0, -90.0) - 1.0).abs() < 1e-6); // 0 dB → full
        // -90 dB (mag = reference/10^4.5) maps to ~0.
        let floor_mag = 100.0 * 10f32.powf(-90.0 / 20.0);
        assert!(normalize_db(floor_mag, 100.0, -90.0) < 1e-3);
        // Louder than reference clamps at 1.
        assert_eq!(normalize_db(1000.0, 100.0, -90.0), 1.0);
    }

    #[test]
    fn log_band_edges_are_monotonic_and_span_the_range() {
        let edges = band_edges(8, 30.0, 16000.0, false);
        assert_eq!(edges.len(), 9);
        assert!((edges[0] - 30.0).abs() < 1e-3);
        assert!((edges[8] - 16000.0).abs() < 1.0);
        for w in edges.windows(2) {
            assert!(w[1] > w[0], "edges must increase: {:?}", w);
        }
        // Equal octave ratios (geometric spacing).
        let r0 = edges[1] / edges[0];
        let r1 = edges[2] / edges[1];
        assert!((r0 - r1).abs() < 1e-3, "{r0} vs {r1}");
    }

    #[test]
    fn linear_band_edges_are_evenly_spaced() {
        let edges = band_edges(8, 0.0, 16000.0, true);
        assert_eq!(edges.len(), 9);
        assert!((edges[0]).abs() < 1e-3);
        assert!((edges[8] - 16000.0).abs() < 1.0);
        // Equal differences (linear spacing), unlike the geometric log edges.
        let d0 = edges[1] - edges[0];
        let d1 = edges[2] - edges[1];
        assert!((d0 - d1).abs() < 1e-3, "{d0} vs {d1}");
    }

    #[test]
    fn to_bands_is_zero_for_silence_and_clamped_0_1() {
        let mags = vec![0.0; FFT_SIZE / 2 + 1];
        let bands = to_bands(&mags, SAMPLE_RATE, FFT_SIZE, 32, false);
        assert_eq!(bands.len(), 32);
        assert!(bands.iter().all(|&b| b == 0.0));

        // A single loud bin lights its band and stays within 0..1.
        let mut mags = vec![0.0; FFT_SIZE / 2 + 1];
        let bin = (1000.0 / (SAMPLE_RATE as f32 / FFT_SIZE as f32)) as usize;
        mags[bin] = FFT_SIZE as f32 / 4.0; // ≈ full scale
        let bands = to_bands(&mags, SAMPLE_RATE, FFT_SIZE, 32, false);
        assert!(bands.iter().all(|&b| (0.0..=1.0).contains(&b)));
        assert!(
            bands.iter().cloned().fold(0.0_f32, f32::max) > 0.9,
            "1 kHz band should be near full"
        );
    }

    #[test]
    fn smooth_rises_fast_and_falls_slow() {
        // Rising toward 1.0 by ATTACK from 0.0.
        let up = smooth(&[0.0], &[1.0], 0.7, 0.18);
        assert!((up[0] - 0.7).abs() < 1e-6);
        // Falling toward 0.0 by RELEASE from 1.0.
        let down = smooth(&[1.0], &[0.0], 0.7, 0.18);
        assert!((down[0] - 0.82).abs() < 1e-6);
    }

    /// End-to-end DSP: a pure 1 kHz sine should concentrate energy in the band covering 1 kHz and
    /// leave distant bands near zero. Exercises the FFT plan + windowing + binning together.
    #[test]
    fn processor_concentrates_a_pure_tone_in_the_right_band() {
        let band_count = 48;
        let mut proc = SpectrumProcessor::new(SAMPLE_RATE, FFT_SIZE);
        let freq = 1000.0_f32;
        let samples: Vec<f32> = (0..FFT_SIZE)
            .map(|i| (std::f32::consts::TAU * freq * i as f32 / SAMPLE_RATE as f32).sin())
            .collect();
        let level = rms(&samples);
        // Run a few frames so the envelope settles toward the steady-state magnitude.
        let mut frame = proc
            .compute_frames(&samples, &[(band_count, false)], level, 0)
            .remove(0);
        for _ in 0..12 {
            frame = proc
                .compute_frames(&samples, &[(band_count, false)], level, 0)
                .remove(0);
        }
        assert_eq!(frame.bands.len(), band_count);
        assert!(frame.bands.iter().all(|&b| (0.0..=1.0).contains(&b)));

        // Which band owns 1 kHz?
        let edges = band_edges(
            band_count,
            FMIN_HZ,
            FMAX_HZ.min(SAMPLE_RATE as f32 / 2.0),
            false,
        );
        let tone_band = (0..band_count)
            .find(|&b| freq >= edges[b] && freq < edges[b + 1])
            .expect("1 kHz within range");
        let peak = frame.bands[tone_band];
        assert!(peak > 0.5, "tone band should be strong, got {peak}");

        // A far-away band (well below the tone, e.g. ~50 Hz) should be near silent.
        let low_band = (0..band_count).find(|&b| edges[b + 1] < 100.0).unwrap_or(0);
        assert!(
            frame.bands[low_band] < 0.2,
            "low band should be quiet, got {}",
            frame.bands[low_band]
        );
    }

    /// Two subscribers of one capture asking for different scales get their own binning off the
    /// SAME FFT — each identical to what a dedicated single-variant processor produces (independent
    /// envelopes, no cross-talk) — and log vs linear really differ.
    #[test]
    fn processor_bins_each_variant_independently_from_one_fft() {
        let tone: Vec<f32> = (0..FFT_SIZE)
            .map(|i| (std::f32::consts::TAU * 1000.0 * i as f32 / SAMPLE_RATE as f32).sin())
            .collect();
        let level = rms(&tone);
        let both = [(48, false), (32, true)];
        let mut shared = SpectrumProcessor::new(SAMPLE_RATE, FFT_SIZE);
        let mut log_only = SpectrumProcessor::new(SAMPLE_RATE, FFT_SIZE);
        let mut linear_only = SpectrumProcessor::new(SAMPLE_RATE, FFT_SIZE);
        for _ in 0..5 {
            let frames = shared.compute_frames(&tone, &both, level, 7);
            let log = log_only.compute_frames(&tone, &[(48, false)], level, 7);
            let lin = linear_only.compute_frames(&tone, &[(32, true)], level, 7);
            assert_eq!(frames.len(), 2);
            assert_eq!(frames[0].bands, log[0].bands);
            assert_eq!(frames[1].bands, lin[0].bands);
            assert_eq!(frames[1].ts_ms, 7);
        }
        let frames = shared.compute_frames(&tone, &both, level, 0);
        assert_eq!(frames[0].bands.len(), 48);
        assert_eq!(frames[1].bands.len(), 32);
        // A variant no longer requested drops its envelope: re-adding it starts from silence.
        shared.compute_frames(&[], &[(48, false)], 0.0, 0);
        let restarted = shared.compute_frames(&tone, &[(32, true)], level, 0);
        let fresh = SpectrumProcessor::new(SAMPLE_RATE, FFT_SIZE).compute_frames(
            &tone,
            &[(32, true)],
            level,
            0,
        );
        assert_eq!(restarted[0].bands, fresh[0].bands);
    }

    #[test]
    fn choose_capture_joins_opens_or_shares_the_closest_at_the_bound() {
        // Joins a live capture for the same device, even at the bound.
        assert_eq!(
            choose_capture(&["a", "b"], "a", 2),
            ("a".to_string(), false)
        );
        // Opens its own while under the bound (incl. the very first).
        assert_eq!(choose_capture(&[], "", 4), (String::new(), false));
        assert_eq!(choose_capture(&["a"], "b", 2), ("b".to_string(), false));
        // At the bound: share the system-default capture when one is live…
        assert_eq!(
            choose_capture(&["b", "", "a"], "c", 3),
            (String::new(), true)
        );
        // …else the first device by id (deterministic, independent of map order).
        assert_eq!(
            choose_capture(&["c", "a", "b"], "d", 3),
            ("a".to_string(), true)
        );
    }

    fn sub(band_count: usize, linear: bool) -> Subscriber {
        Subscriber {
            channel: Channel::new(|_| Ok(())),
            band_count,
            linear,
        }
    }

    fn key(label: &str, k: &str) -> SubKey {
        (label.to_string(), k.to_string())
    }

    fn subscriber_count(inner: &SpectrumInner, device: &str) -> usize {
        inner
            .captures
            .get(device)
            .map_or(0, |c| c.subscribers.len())
    }

    /// The reported bug: two widgets with different devices each get their own capture (one spawn
    /// per device) instead of the last start winning; same device + different scale shares one.
    #[test]
    fn subscribe_runs_one_capture_per_device_and_shares_across_scales() {
        let mut inner = SpectrumInner::default();
        let p = inner.subscribe(key("main", "log|"), "", sub(128, false));
        assert_eq!(
            p,
            Placement {
                capture: String::new(),
                spawn: true,
                fell_back: false
            }
        );
        let p = inner.subscribe(key("main", "log|hdmi"), "hdmi", sub(128, false));
        assert_eq!((p.capture.as_str(), p.spawn), ("hdmi", true));
        // Another window, same device, linear scale: joins the running capture — no new thread.
        let p = inner.subscribe(key("overlay-1", "linear|hdmi"), "hdmi", sub(128, true));
        assert_eq!(
            (p.capture.as_str(), p.spawn, p.fell_back),
            ("hdmi", false, false)
        );
        assert_eq!(subscriber_count(&inner, ""), 1);
        assert_eq!(subscriber_count(&inner, "hdmi"), 2);
        // Both scales are binned for the shared capture.
        let variants = frame_variants(inner.captures["hdmi"].subscribers.values());
        assert_eq!(variants, vec![(128, false), (128, true)]);
    }

    /// Re-subscribing the same (window, key) replaces the old subscription rather than duplicating
    /// it — the watchdog restart / reload path.
    #[test]
    fn resubscribing_a_key_replaces_it() {
        let mut inner = SpectrumInner::default();
        inner.subscribe(key("main", "k"), "a", sub(128, false));
        let p = inner.subscribe(key("main", "k"), "a", sub(128, false));
        assert!(!p.spawn, "the capture is still running");
        assert_eq!(subscriber_count(&inner, "a"), 1);
    }

    /// Past `MAX_CAPTURES` distinct devices, a new device shares an existing capture (flagged so the
    /// command logs a warning); a slot freed by a departed device is reusable.
    #[test]
    fn capture_count_is_bounded() {
        let mut inner = SpectrumInner::default();
        for (i, device) in ["d0", "d1", "d2", "d3"].iter().enumerate() {
            let p = inner.subscribe(key("main", &i.to_string()), device, sub(128, false));
            assert!(p.spawn && !p.fell_back);
        }
        let p = inner.subscribe(key("main", "x"), "d4", sub(128, false));
        assert_eq!(
            p,
            Placement {
                capture: "d0".to_string(),
                spawn: false,
                fell_back: true
            }
        );
        assert_eq!(subscriber_count(&inner, "d0"), 2);
        assert!(!inner.captures.contains_key("d4"));
        // d3's only widget leaves → its capture no longer counts, so d5 gets its own.
        inner.unsubscribe("main", Some("3"));
        let p = inner.subscribe(key("main", "y"), "d5", sub(128, false));
        assert_eq!((p.capture.as_str(), p.fell_back), ("d5", false));
    }

    /// `stop_spectrum` with a key drops just that stream; without one (unload) and `forget_window`
    /// drop every stream of the window across captures. A running capture left empty is kept for its
    /// thread to retire atomically; unknown labels are ignored.
    #[test]
    fn unsubscribe_by_key_or_whole_window() {
        let state = SpectrumState::default();
        {
            let mut inner = state.lock();
            inner.subscribe(key("overlay-1", "a"), "", sub(128, false));
            inner.subscribe(key("overlay-1", "b"), "hdmi", sub(128, true));
            inner.subscribe(key("studio", "a"), "", sub(128, false));
            assert!(inner.unsubscribe("studio", Some("a")));
            assert!(!inner.unsubscribe("studio", Some("a")));
        }
        forget_window(&state, "nope");
        assert_eq!(subscriber_count(&state.lock(), ""), 1);
        forget_window(&state, "overlay-1");
        let mut inner = state.lock();
        assert_eq!(subscriber_count(&inner, ""), 0);
        assert_eq!(subscriber_count(&inner, "hdmi"), 0);
        // Still flagged running: the threads see the empty sets and retire themselves.
        assert!(inner.captures["hdmi"].running);
        assert!(inner.retire_if_idle("hdmi"));
        assert!(!inner.captures.contains_key("hdmi"));
    }

    /// The thread-exit check is atomic with `subscribe`: a subscriber that joined first keeps the
    /// thread alive; once retired, the next subscriber is told to spawn a fresh thread.
    #[test]
    fn retire_and_respawn_never_orphan_a_subscriber() {
        let mut inner = SpectrumInner::default();
        inner.subscribe(key("main", "a"), "", sub(128, false));
        assert!(!inner.retire_if_idle(""), "busy capture keeps running");
        inner.unsubscribe("main", Some("a"));
        assert!(inner.retire_if_idle(""));
        assert!(inner.retire_if_idle(""), "a missing capture is idle");
        assert!(inner.subscribe(key("main", "a"), "", sub(128, false)).spawn);

        // A thread that gave up with subscribers left: the next start for it respawns.
        inner.mark_stopped("");
        assert!(!inner.captures[""].running);
        assert!(inner.subscribe(key("main", "a"), "", sub(128, false)).spawn);
        // Giving up with nobody left prunes the entry so it doesn't hold a capture slot.
        inner.unsubscribe("main", None);
        inner.mark_stopped("");
        assert!(inner.captures.is_empty());
        inner.mark_stopped("unknown");
    }

    #[test]
    fn frame_variants_are_clamped_sorted_and_deduplicated() {
        let subs = [
            sub(4, true),
            sub(128, false),
            sub(128, false),
            sub(999, false),
        ];
        assert_eq!(
            frame_variants(subs.iter()),
            vec![(MIN_BANDS, true), (128, false), (MAX_BANDS, false)]
        );
    }

    #[test]
    fn magnitudes_computes_complex_modulus() {
        let m = magnitudes(&[Complex::new(3.0, 4.0), Complex::new(0.0, 0.0)]);
        assert!((m[0] - 5.0).abs() < 1e-6);
        assert_eq!(m[1], 0.0);
    }

    /// The `com_call` tests share the process-wide in-flight counter, so they run one at a time.
    async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
        static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        LOCK.lock().await
    }

    /// The off-UI-thread wrapper returns the closure's value when it finishes in time…
    #[tokio::test]
    async fn com_call_returns_the_value_within_budget() {
        let _serial = serial().await;
        let v = com_call("t", Duration::from_secs(1), || 42u8).await;
        assert_eq!(v, Ok(42));
    }

    /// …and releases the caller with an error (naming the command) when it overruns the budget,
    /// instead of blocking for as long as the (stuck) COM call takes.
    #[tokio::test]
    async fn com_call_times_out_and_names_the_command() {
        let _serial = serial().await;
        let started = std::time::Instant::now();
        let v = com_call("get_audio_volume", Duration::from_millis(30), || {
            std::thread::sleep(Duration::from_millis(400));
            1u8
        })
        .await;
        let err = v.unwrap_err();
        assert!(err.contains("get_audio_volume"), "{err}");
        assert!(err.contains("timed out"), "{err}");
        assert!(
            started.elapsed() < Duration::from_millis(350),
            "caller was released early"
        );
        // Let the stuck closure finish so it doesn't count against the next test's bound.
        tokio::time::sleep(Duration::from_millis(450)).await;
    }

    /// While `COM_CALL_MAX_IN_FLIGHT` calls are stuck, a further one fails fast (no new pool thread
    /// parked behind the hung audio service); once they drain, calls go through again.
    #[tokio::test]
    async fn com_call_fails_fast_past_the_in_flight_bound() {
        let _serial = serial().await;
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let release_rx = std::sync::Arc::new(std::sync::Mutex::new(release_rx));
        let mut stuck = Vec::new();
        for _ in 0..COM_CALL_MAX_IN_FLIGHT {
            let rx = release_rx.clone();
            stuck.push(tokio::spawn(com_call(
                "stuck",
                Duration::from_millis(20),
                move || {
                    // Block until released — no lock is held across the wait.
                    let guard = rx.lock().unwrap_or_else(|e| e.into_inner());
                    let _ = guard.recv();
                },
            )));
        }
        // Each stuck call has timed out for its caller, but the closures are still running.
        for h in stuck {
            assert!(h.await.unwrap().is_err());
        }
        let err = com_call("busy", Duration::from_secs(1), || 1u8)
            .await
            .unwrap_err();
        assert!(err.contains("busy"), "{err}");
        // Release them and wait for the count to drain; then the call goes through.
        drop(release_tx);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while COM_CALLS_IN_FLIGHT.load(std::sync::atomic::Ordering::Acquire) > 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "in-flight count never drained"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(com_call("ok", Duration::from_secs(1), || 1u8).await, Ok(1));
    }
}
