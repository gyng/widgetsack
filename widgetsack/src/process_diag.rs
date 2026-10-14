//! The app's OWN native (host) process perf snapshot for the studio Diagnostics panel: CPU% + memory
//! of THIS Tauri process. The JS heap of each webview is reported separately over the diag bridge; on
//! Windows the WebView2 renderers are their own processes, so this is the Rust host process alone — a
//! complement to the per-window heap rows, not a total of them.
//!
//! `sysinfo` is kept at this edge (an adapter, like `sensors.rs`); the `ProcessDiag` struct crosses the
//! bridge and mirrors `ProcessDiag` in `client/src/lib/diag.ts`. Per-process CPU% is a DELTA between two
//! refreshes, so a persistent `System` is held as managed state and reused across the panel's polls.

use std::sync::Mutex;

use serde::Serialize;
use sysinfo::{Pid, ProcessesToUpdate, System};

/// Managed state: a persistent `System` so per-process CPU% can be derived from successive refreshes
/// (sysinfo computes process CPU usage as the delta between two refreshes). The CPU list is primed at
/// construction so the logical-core count is available for the machine-percent normalisation.
pub struct ProcDiag(pub Mutex<System>);

impl Default for ProcDiag {
    fn default() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_all(); // populate cpus() for the core count used below
        ProcDiag(Mutex::new(sys))
    }
}

/// This process's perf snapshot. Mirrors `ProcessDiag` in `client/src/lib/diag.ts` (camelCase).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDiag {
    /// The host process id.
    pub pid: u32,
    /// CPU usage as a percent of the WHOLE machine (sysinfo sums across cores; divided by the logical
    /// core count, like `cpu.total` / `proc.cpu.top.pct`). ~0 on the first poll (needs a delta).
    pub cpu_percent: f64,
    /// Resident set size (physical memory) in bytes.
    pub mem_bytes: u64,
    /// Virtual memory size in bytes.
    pub virtual_bytes: u64,
    /// Seconds this process has been running.
    pub uptime_secs: u64,
    /// Logical CPU count (lets the UI show raw per-core load if it wants).
    pub cpus: u32,
}

/// Normalise sysinfo's summed-across-cores process CPU% into a "% of the whole machine" reading,
/// matching `proc.cpu.top.pct` and `cpu.total`. Pure seam. `cpus` of 0 is treated as 1 (no div-by-0).
fn machine_cpu_percent(summed: f32, cpus: usize) -> f64 {
    summed as f64 / cpus.max(1) as f64
}

/// Snapshot THIS process's CPU% + memory. Refreshes only our own PID (cheap — one process) on the
/// persistent `System`, so successive polls give a real CPU delta. Returns the live pid/cpus with zero
/// metrics if the process can't be read — never errors.
#[tauri::command(async)]
pub fn process_diagnostics(state: tauri::State<'_, ProcDiag>) -> ProcessDiag {
    let pid = std::process::id();
    let spid = Pid::from_u32(pid);
    let mut sys = state.0.lock().unwrap_or_else(|e| e.into_inner());
    sys.refresh_processes(ProcessesToUpdate::Some(&[spid]), true);
    let cpus = sys.cpus().len();
    let base = ProcessDiag {
        pid,
        cpus: cpus as u32,
        ..Default::default()
    };
    match sys.process(spid) {
        Some(proc) => ProcessDiag {
            cpu_percent: machine_cpu_percent(proc.cpu_usage(), cpus),
            mem_bytes: proc.memory(),
            virtual_bytes: proc.virtual_memory(),
            uptime_secs: proc.run_time(),
            ..base
        },
        None => base,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_cpu_percent_normalises_summed_usage() {
        // 400% summed on a 4-core machine = 100% of the machine.
        assert_eq!(machine_cpu_percent(400.0, 4), 100.0);
        // 50% summed on a single core = 50%.
        assert_eq!(machine_cpu_percent(50.0, 1), 50.0);
        // cpus = 0 is treated as 1 (no division by zero).
        assert_eq!(machine_cpu_percent(25.0, 0), 25.0);
    }

    #[test]
    fn process_diag_serializes_to_the_camel_case_bridge_contract() {
        let d = ProcessDiag {
            pid: 1234,
            cpu_percent: 12.5,
            mem_bytes: 100,
            virtual_bytes: 200,
            uptime_secs: 42,
            cpus: 8,
        };
        let json = serde_json::to_value(&d).unwrap();
        assert_eq!(json["pid"], 1234);
        assert_eq!(json["cpuPercent"], 12.5);
        assert_eq!(json["memBytes"], 100);
        assert_eq!(json["virtualBytes"], 200);
        assert_eq!(json["uptimeSecs"], 42);
        assert_eq!(json["cpus"], 8);
    }
}
