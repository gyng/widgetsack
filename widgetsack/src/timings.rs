//! Opt-in per-subsystem CPU timing for the studio Diagnostics "backend CPU" panel. The sensor loop +
//! plugin pollers wrap each unit of work in a `start(key)` RAII timer; when profiling is DISABLED (the
//! panel isn't open) the timer is inert, so there is ZERO cost when nobody is watching. The panel
//! toggles it via `set_subsystem_profiling` and reads `subsystem_timings`. Wall-clock time per block is
//! a good CPU proxy (tokio gives no per-task CPU; this is the measurable seam). Demand-gated by design.
//!
//! `ms_per_sec` (avg block time × how often it runs) is the headline number: the real load a subsystem
//! imposes — e.g. a 5 ms process refresh at 1 Hz = 5 ms/s ≈ 0.5% of one core.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

#[derive(Default)]
struct Accum {
    total_us: u64,
    samples: u64,
    last_us: u64,
    first_ms: u64,
    last_ms: u64,
}

/// Managed state: the on/off flag + per-subsystem accumulators. Cleared whenever profiling is disabled
/// (so re-opening the panel starts fresh, and a stale window doesn't skew the rates).
#[derive(Default)]
pub struct SubsystemTimings {
    enabled: AtomicBool,
    map: Mutex<HashMap<&'static str, Accum>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl SubsystemTimings {
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    fn set_enabled(&self, v: bool) {
        self.enabled.store(v, Ordering::Relaxed);
        if !v {
            self.map.lock().unwrap_or_else(|e| e.into_inner()).clear();
        }
    }

    /// Start timing the subsystem `key`; the returned guard records the elapsed time on drop — but
    /// ONLY if profiling is enabled, so the call is ~free (one atomic load + an Instant) when it isn't.
    pub fn start(&self, key: &'static str) -> Timer<'_> {
        Timer {
            timings: self,
            key,
            start: Instant::now(),
            active: self.is_enabled(),
        }
    }

    fn record(&self, key: &'static str, dur: Duration) {
        let us = dur.as_micros() as u64;
        let t = now_ms();
        let mut m = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let a = m.entry(key).or_default();
        if a.samples == 0 {
            a.first_ms = t;
        }
        a.total_us += us;
        a.samples += 1;
        a.last_us = us;
        a.last_ms = t;
    }

    fn snapshot(&self) -> Vec<SubsystemTiming> {
        let m = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<SubsystemTiming> = m
            .iter()
            .map(|(k, a)| {
                let avg_ms = if a.samples > 0 {
                    a.total_us as f64 / a.samples as f64 / 1000.0
                } else {
                    0.0
                };
                let span_s = a.last_ms.saturating_sub(a.first_ms) as f64 / 1000.0;
                let per_sec = if a.samples > 1 && span_s > 0.0 {
                    (a.samples - 1) as f64 / span_s
                } else {
                    0.0
                };
                SubsystemTiming {
                    key: (*k).to_string(),
                    avg_ms,
                    last_ms: a.last_us as f64 / 1000.0,
                    samples: a.samples,
                    per_sec,
                    ms_per_sec: avg_ms * per_sec,
                }
            })
            .collect();
        out.sort_by(|a, b| {
            b.ms_per_sec
                .partial_cmp(&a.ms_per_sec)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out
    }
}

/// RAII timer — records `key`'s elapsed time on drop when `active`. Inert otherwise.
pub struct Timer<'a> {
    timings: &'a SubsystemTimings,
    key: &'static str,
    start: Instant,
    active: bool,
}
impl Drop for Timer<'_> {
    fn drop(&mut self) {
        if self.active {
            self.timings.record(self.key, self.start.elapsed());
        }
    }
}

/// One subsystem's timing for the panel. camelCase on the wire.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubsystemTiming {
    pub key: String,
    /// Average wall-clock time per run of this block (ms).
    pub avg_ms: f64,
    /// The most recent run's time (ms).
    pub last_ms: f64,
    /// How many runs have been timed since profiling was enabled.
    pub samples: u64,
    /// How often the block runs (runs/sec) over the profiling window.
    pub per_sec: f64,
    /// The headline load: avg_ms × per_sec — ms of CPU this subsystem uses per second.
    pub ms_per_sec: f64,
}

/// Enable/disable the timing instrumentation (the Diagnostics panel turns it on while open). Disabling
/// clears the accumulators. Studio-window-guarded like the other diagnostics commands.
#[tauri::command]
pub fn set_subsystem_profiling(
    window: tauri::WebviewWindow,
    enabled: bool,
    state: State<SubsystemTimings>,
) -> Result<(), String> {
    if window.label() != "studio" {
        return Err("set_subsystem_profiling is only allowed from the studio window".into());
    }
    state.set_enabled(enabled);
    Ok(())
}

/// The per-subsystem timings, busiest (most ms/sec) first. Empty until profiling is enabled + a few
/// ticks have run.
#[tauri::command]
pub fn subsystem_timings(state: State<SubsystemTimings>) -> Vec<SubsystemTiming> {
    state.snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_records_nothing_then_enabled_accumulates() {
        let t = SubsystemTimings::default();
        // Disabled: the guard is inert.
        drop(t.start("gpu"));
        assert!(t.snapshot().is_empty());

        t.set_enabled(true);
        t.record("gpu", Duration::from_micros(2000)); // 2 ms
        t.record("gpu", Duration::from_micros(4000)); // 4 ms → avg 3 ms
        t.record("disk", Duration::from_micros(500));

        let snap = t.snapshot();
        assert_eq!(snap.len(), 2);
        let gpu = snap.iter().find(|s| s.key == "gpu").unwrap();
        assert_eq!(gpu.samples, 2);
        assert!((gpu.avg_ms - 3.0).abs() < 1e-9);
        assert!((gpu.last_ms - 4.0).abs() < 1e-9);
        let disk = snap.iter().find(|s| s.key == "disk").unwrap();
        assert_eq!(disk.samples, 1);
        assert!((disk.avg_ms - 0.5).abs() < 1e-9);
    }

    #[test]
    fn disabling_clears_the_accumulators() {
        let t = SubsystemTimings::default();
        t.set_enabled(true);
        t.record("perf", Duration::from_micros(1000));
        assert_eq!(t.snapshot().len(), 1);
        t.set_enabled(false);
        assert!(t.snapshot().is_empty());
    }
}
