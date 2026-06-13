//! Audio spectrum source: capture the system output via WASAPI loopback, run a real-input FFT,
//! and stream a small per-frame band array to the webview over a Tauri `Channel` — the data
//! backing the `spectrum` widget (a canvas visualiser).
//!
//! Why a `Channel` and not the `telemetry` event: a spectrum is ~32–128 floats at up to 60 Hz,
//! whereas telemetry is scalar samples at 1 Hz and the hub collapses a series to its last value
//! (`appendSample` in `core/telemetry.ts`). Tauri's event system is documented as "not designed
//! for low latency or high throughput"; `Channel<T>` is the streaming transport. One channel per
//! subscribing window; capture runs once and fans each frame out to all of them.
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
use std::time::{SystemTime, UNIX_EPOCH};

use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::Runtime;

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
    (0..=band_count).map(|i| fmin * ratio.powi(i as i32)).collect()
}

/// Group linear FFT-bin magnitudes into `band_count` display bands over [`FMIN_HZ`, `FMAX_HZ`]
/// (log- or `linear`-spaced), each the dB-normalised (0..1) PEAK magnitude within its frequency span.
/// Peak (not average) keeps narrow tones visible. The frequency range and dB floor are the fixed
/// app constants, so they aren't parameters.
fn to_bands(mags: &[f32], sample_rate: u32, fft_size: usize, band_count: usize, linear: bool) -> Vec<f32> {
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

/// Stateful analyser: owns the reusable FFT plan, the window, scratch buffers and the smoothed
/// band state. `compute_frame` is the hot path — windows the samples, runs one real FFT, bins to
/// log bands and applies the envelope. Pure given its inputs (testable without audio hardware).
struct SpectrumProcessor {
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    input: Vec<f32>,
    spectrum: Vec<Complex<f32>>,
    smoothed: Vec<f32>,
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
            smoothed: Vec::new(),
            sample_rate,
            fft_size,
        }
    }

    /// Analyse the most recent `fft_size` samples into a `SpectrumFrame`. `samples` must be at least
    /// `fft_size` long; only the trailing window is used. `level` is the precomputed RMS; `linear`
    /// picks linear vs log frequency band spacing.
    fn compute_frame(
        &mut self,
        samples: &[f32],
        band_count: usize,
        linear: bool,
        level: f32,
        ts_ms: u64,
    ) -> SpectrumFrame {
        let start = samples.len().saturating_sub(self.fft_size);
        let window = &samples[start..];
        for (i, slot) in self.input.iter_mut().enumerate() {
            *slot = window.get(i).copied().unwrap_or(0.0) * self.window[i];
        }
        // realfft uses `input` as scratch and writes N/2+1 complex bins into `spectrum`.
        if self.fft.process(&mut self.input, &mut self.spectrum).is_ok() {
            let mags = magnitudes(&self.spectrum);
            let bands = to_bands(&mags, self.sample_rate, self.fft_size, band_count, linear);
            if self.smoothed.len() != band_count {
                self.smoothed = vec![0.0; band_count];
            }
            self.smoothed = smooth(&self.smoothed, &bands, ATTACK, RELEASE);
        } else if self.smoothed.len() != band_count {
            self.smoothed = vec![0.0; band_count];
        }
        SpectrumFrame {
            bands: self.smoothed.clone(),
            rms: level,
            ts_ms,
        }
    }
}

// --- Shared state + lifecycle ------------------------------------------------------------------

/// Subscribed channels (one per window label) plus the capture-thread liveness flag and the current
/// band count. A plain `std::sync::Mutex` — locks are brief and never held across the FFT or I/O.
#[derive(Default)]
struct SpectrumInner {
    channels: HashMap<String, Channel<SpectrumFrame>>,
    running: bool,
    band_count: usize,
    /// The chosen output device id (WASAPI endpoint id), or `None` for the system default. The
    /// running session re-initialises when this changes so a device switch takes effect live.
    device: Option<String>,
    /// Linear (vs the default log) frequency band spacing. Read live each frame.
    linear: bool,
}

/// Managed Tauri state shared with the capture thread via the inner `Arc`.
#[derive(Default, Clone)]
pub struct SpectrumState(Arc<Mutex<SpectrumInner>>);

impl SpectrumState {
    fn lock(&self) -> std::sync::MutexGuard<'_, SpectrumInner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Start (or join) the spectrum stream for the calling window: register its channel and, if the
/// capture thread isn't already running, spawn it. Idempotent per window — a second call replaces
/// that window's channel (e.g. after a reload). `bands` picks the display band count.
#[tauri::command]
pub fn start_spectrum<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, SpectrumState>,
    channel: Channel<SpectrumFrame>,
    bands: Option<usize>,
    device: Option<String>,
    scale: Option<String>,
) -> Result<(), String> {
    let mut inner = state.lock();
    inner.band_count = bands.unwrap_or(DEFAULT_BANDS).clamp(MIN_BANDS, MAX_BANDS);
    inner.device = device.filter(|d| !d.is_empty());
    inner.linear = matches!(scale.as_deref(), Some("linear"));
    inner.channels.insert(window.label().to_string(), channel);
    let need_spawn = !inner.running;
    if need_spawn {
        inner.running = true;
    }
    drop(inner);
    if need_spawn {
        spawn_capture((*state).clone());
    }
    Ok(())
}

/// Stop the spectrum stream for the calling window: drop its channel. When the last window
/// unsubscribes the capture thread sees an empty channel set and exits on its own.
#[tauri::command]
pub fn stop_spectrum<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, SpectrumState>,
) -> Result<(), String> {
    state.lock().channels.remove(window.label());
    Ok(())
}

/// List the system's audio OUTPUT (render) endpoints, so the inspector can offer a device picker.
/// An empty selection means "system default". Windows-only; elsewhere there is no loopback backend
/// so the list is empty (the meter just shows nothing).
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn list_audio_outputs() -> Result<Vec<AudioDevice>, String> {
    use wasapi::{initialize_mta, Direction};
    // The command may run on a COM-uninitialised pool thread; init MTA (a no-op / harmless
    // RPC_E_CHANGED_MODE if COM is already up on this thread — enumeration works either way).
    let _ = initialize_mta().ok();
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
pub fn list_audio_outputs() -> Result<Vec<AudioDevice>, String> {
    Ok(Vec::new())
}

// --- Default output-device control (the Audio Switcher widget) ----------------------------------
// Reading the current default uses the documented wasapi enumerator; SETTING it uses the
// undocumented-but-stable IPolicyConfig COM interface (CPolicyConfigClient) — the same mechanism
// nircmd / SoundSwitch use, because Windows exposes no public API to set the default endpoint.

/// The current default RENDER endpoint's WASAPI id, so the switcher can mark the active device.
/// `None` on failure / non-Windows.
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn default_audio_output() -> Option<String> {
    use wasapi::{initialize_mta, Direction};
    let _ = initialize_mta().ok();
    let enumerator = wasapi::DeviceEnumerator::new().ok()?;
    enumerator
        .get_default_device(&Direction::Render)
        .ok()?
        .get_id()
        .ok()
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn default_audio_output() -> Option<String> {
    None
}

/// IPolicyConfig — the undocumented endpoint-policy COM interface. Only `set_default_endpoint` is
/// used; the methods before it are declared as opaque slots SOLELY to preserve the vtable layout
/// (COM dispatch is by ordinal, so every earlier method must occupy its slot). IID + CLSID are the
/// long-stable CPolicyConfigClient values.
#[cfg(target_os = "windows")]
#[windows::core::interface("f8679f50-850a-41cf-9c72-430f290290c8")]
unsafe trait IPolicyConfig: windows::core::IUnknown {
    unsafe fn get_mix_format(&self, id: windows::core::PCWSTR, fmt: *mut *mut ::core::ffi::c_void) -> windows::core::HRESULT;
    unsafe fn get_device_format(&self, id: windows::core::PCWSTR, default: i32, fmt: *mut *mut ::core::ffi::c_void) -> windows::core::HRESULT;
    unsafe fn reset_device_format(&self, id: windows::core::PCWSTR) -> windows::core::HRESULT;
    unsafe fn set_device_format(&self, id: windows::core::PCWSTR, endpoint_fmt: *mut ::core::ffi::c_void, mix_fmt: *mut ::core::ffi::c_void) -> windows::core::HRESULT;
    unsafe fn get_processing_period(&self, id: windows::core::PCWSTR, default: i32, default_period: *mut i64, min_period: *mut i64) -> windows::core::HRESULT;
    unsafe fn set_processing_period(&self, id: windows::core::PCWSTR, period: *mut i64) -> windows::core::HRESULT;
    unsafe fn get_share_mode(&self, id: windows::core::PCWSTR, mode: *mut ::core::ffi::c_void) -> windows::core::HRESULT;
    unsafe fn set_share_mode(&self, id: windows::core::PCWSTR, mode: *mut ::core::ffi::c_void) -> windows::core::HRESULT;
    unsafe fn get_property_value(&self, id: windows::core::PCWSTR, key: i32, value: *const ::core::ffi::c_void, out: *mut ::core::ffi::c_void) -> windows::core::HRESULT;
    unsafe fn set_property_value(&self, id: windows::core::PCWSTR, key: i32, value: *const ::core::ffi::c_void, out: *mut ::core::ffi::c_void) -> windows::core::HRESULT;
    /// SetDefaultEndpoint(wszDeviceId, eRole) — the one we call. role: 0 eConsole, 1 eMultimedia, 2 eCommunications.
    unsafe fn set_default_endpoint(&self, device_id: windows::core::PCWSTR, role: u32) -> windows::core::HRESULT;
    unsafe fn set_endpoint_visibility(&self, id: windows::core::PCWSTR, visible: i32) -> windows::core::HRESULT;
}

/// Make `id` the default render endpoint for ALL roles (console + multimedia + communications), like
/// the Sound control panel's "Set Default". Callable from any window (it's a widget action, not a
/// studio-only setting). No-op error off Windows.
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn set_default_audio_output(id: String) -> Result<(), String> {
    use std::iter::once;
    use windows::core::PCWSTR;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    // CPolicyConfigClient.
    const CLSID_POLICY_CONFIG: windows::core::GUID =
        windows::core::GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

    if id.is_empty() {
        return Err("empty device id".into());
    }
    // SAFETY: standard COM create-and-call; the device id is a NUL-terminated UTF-16 string that
    // outlives the calls. IPolicyConfig's vtable layout is preserved (see the interface decl).
    unsafe {
        // The command may run on a COM-uninitialised pool thread; init MTA (harmless if already up).
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
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
pub fn set_default_audio_output(_id: String) -> Result<(), String> {
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

/// Acquire the default render endpoint's `IAudioEndpointVolume`. COM is initialised MTA on the calling
/// (pool) thread; `RPC_E_CHANGED_MODE` if already up in another mode is harmless.
#[cfg(target_os = "windows")]
fn endpoint_volume() -> windows::core::Result<windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume>
{
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

    // SAFETY: standard COM create/activate; every interface is released on drop.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        device.Activate(CLSCTX_ALL, None)
    }
}

/// Read the system master volume + mute. `None` on failure / non-Windows.
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn get_audio_volume() -> Option<AudioVolume> {
    // SAFETY: standard Core Audio read; all interfaces are released on drop.
    unsafe {
        let vol = endpoint_volume().ok()?;
        let level = vol.GetMasterVolumeLevelScalar().ok()?;
        let muted = vol.GetMute().ok()?.as_bool();
        Some(AudioVolume { level, muted })
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn get_audio_volume() -> Option<AudioVolume> {
    None
}

/// Set the system master volume (scalar 0..1, clamped). No-op error off Windows.
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn set_audio_volume(level: f32) -> Result<(), String> {
    // SAFETY: writes the master scalar level; eventcontext is null (no callback correlation needed).
    unsafe {
        let vol = endpoint_volume().map_err(|e| e.to_string())?;
        vol.SetMasterVolumeLevelScalar(level.clamp(0.0, 1.0), std::ptr::null())
            .map_err(|e| e.to_string())
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn set_audio_volume(_level: f32) -> Result<(), String> {
    Err("setting the volume is only supported on Windows".into())
}

/// Set the system mute state. No-op error off Windows.
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn set_audio_mute(muted: bool) -> Result<(), String> {
    // SAFETY: writes the mute flag; eventcontext is null.
    unsafe {
        let vol = endpoint_volume().map_err(|e| e.to_string())?;
        vol.SetMute(muted, std::ptr::null()).map_err(|e| e.to_string())
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn set_audio_mute(_muted: bool) -> Result<(), String> {
    Err("muting is only supported on Windows".into())
}

/// Spawn the dedicated capture thread (Windows only; elsewhere there is no loopback backend, so
/// clear the flag immediately so the state doesn't claim to be running).
#[cfg(target_os = "windows")]
fn spawn_capture(state: SpectrumState) {
    let _ = std::thread::Builder::new()
        .name("spectrum-capture".to_string())
        .spawn(move || run_capture(&state));
}

#[cfg(not(target_os = "windows"))]
fn spawn_capture(state: SpectrumState) {
    state.lock().running = false;
}

// --- WASAPI loopback capture (Windows adapter) -------------------------------------------------

#[cfg(target_os = "windows")]
mod capture {
    use super::*;
    use std::collections::VecDeque;
    use std::time::{Duration, Instant};
    use wasapi::{
        initialize_mta, Direction, SampleType, StreamMode, WaveFormat,
    };

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
    pub(super) fn run_capture(state: &SpectrumState) {
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
            {
                let mut inner = state.lock();
                if inner.channels.is_empty() {
                    inner.running = false;
                    return;
                }
            }

            match run_session(state) {
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
                log::error("audio", "spectrum: giving up after repeated capture failures").emit();
                state.lock().running = false;
                return;
            }
            if failures > 0 {
                std::thread::sleep(RETRY_BACKOFF);
            }
        }
    }

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

    /// One capture session against the chosen (or default) render device. Returns when subscribers
    /// drop (NoSubscribers) or a recoverable device error / device switch occurs (DeviceLost).
    fn run_session(state: &SpectrumState) -> Result<SessionEnd, Box<dyn std::error::Error>> {
        let enumerator = wasapi::DeviceEnumerator::new()?;
        // The chosen output device id at session start; the session re-inits if it changes (below).
        let session_device = state.lock().device.clone();
        // Loopback = the RENDER endpoint (speakers) opened as a CAPTURE client (wasapi sets
        // AUDCLNT_STREAMFLAGS_LOOPBACK for the Render-device + Capture-direction + Shared combo).
        let device = open_render_device(&enumerator, session_device.as_deref())?;
        let device_name = device
            .get_friendlyname()
            .unwrap_or_else(|_| "unknown".to_string());
        let mut audio_client = device.get_iaudioclient()?;

        let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE as usize, CHANNELS as usize, None);
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
        // Keep a little more than one window so `compute_frame` always has a full FFT_SIZE.
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
            // all — a frozen/blank widget. compute_frame zero-pads a short buffer, so an idle stream
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
                    let (band_count, linear) = {
                        let inner = state.lock();
                        if inner.channels.is_empty() {
                            let _ = audio_client.stop_stream();
                            return Ok(SessionEnd::NoSubscribers);
                        }
                        // The user picked a different output device — re-init the session on it.
                        if inner.device != session_device {
                            let _ = audio_client.stop_stream();
                            return Ok(SessionEnd::DeviceLost { emitted });
                        }
                        // band count + scale are read live so inspector changes apply without a re-init.
                        (inner.band_count.clamp(MIN_BANDS, MAX_BANDS), inner.linear)
                    };
                    let frame = processor.compute_frame(&mono, band_count, linear, level, now_ms());

                    let mut inner = state.lock();
                    let mut dead: Vec<String> = Vec::new();
                    for (label, channel) in inner.channels.iter() {
                        if channel.send(frame.clone()).is_err() {
                            dead.push(label.clone());
                        }
                    }
                    for label in dead {
                        inner.channels.remove(&label);
                    }
                    if inner.channels.is_empty() {
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
        assert!(bands.iter().cloned().fold(0.0_f32, f32::max) > 0.9, "1 kHz band should be near full");
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
        let mut frame = proc.compute_frame(&samples, band_count, false, level, 0);
        for _ in 0..12 {
            frame = proc.compute_frame(&samples, band_count, false, level, 0);
        }
        assert_eq!(frame.bands.len(), band_count);
        assert!(frame.bands.iter().all(|&b| (0.0..=1.0).contains(&b)));

        // Which band owns 1 kHz?
        let edges = band_edges(band_count, FMIN_HZ, FMAX_HZ.min(SAMPLE_RATE as f32 / 2.0), false);
        let tone_band = (0..band_count)
            .find(|&b| freq >= edges[b] && freq < edges[b + 1])
            .expect("1 kHz within range");
        let peak = frame.bands[tone_band];
        assert!(peak > 0.5, "tone band should be strong, got {peak}");

        // A far-away band (well below the tone, e.g. ~50 Hz) should be near silent.
        let low_band = (0..band_count)
            .find(|&b| edges[b + 1] < 100.0)
            .unwrap_or(0);
        assert!(frame.bands[low_band] < 0.2, "low band should be quiet, got {}", frame.bands[low_band]);
    }

    #[test]
    fn magnitudes_computes_complex_modulus() {
        let m = magnitudes(&[Complex::new(3.0, 4.0), Complex::new(0.0, 0.0)]);
        assert!((m[0] - 5.0).abs() < 1e-6);
        assert_eq!(m[1], 0.0);
    }
}
