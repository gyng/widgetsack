//! System sensors: sample hardware metrics on an interval and emit them to the
//! webview as a `telemetry` batch event.
//!
//! `sysinfo` / `nvml-wrapper` are kept at this edge (adapters, like `listener.rs` for
//! gsmtc); the `SensorValue` / `SensorSample` domain types below cross the bridge and
//! mirror the TS types in `client/src/lib/core/telemetry.ts`. Keep both sides in sync.
//!
//! Emitted ids (mirror `KNOWN_SENSORS` in `core/sensors.ts`):
//! - CPU: `cpu.total` (%), `cpu.core.N` (%), `cpu.freq` (MHz base, sysinfo, gated), `cpu.brand`
//!   (text), `cpu.cores.logical` / `cpu.cores.physical` (counts). Windows live clock (gated):
//!   `cpu.freq.current` / `cpu.freq.max` (MHz) + per-core `cpu.core.N.freq`.
//! - Memory: `mem.used` (%), `mem.total` / `mem.used.bytes` / `mem.available` / `mem.free`
//!   (bytes). Swap mirrors this: `swap.used` (%), `swap.total` / `swap.used.bytes` / `swap.free`.
//!   Windows commit/cache/kernel (gated): `mem.commit.{used,limit,peak}` / `mem.cached` /
//!   `mem.kernel.{paged,nonpaged}` (bytes).
//! - Network: `net.down` / `net.up` / `net.total` (bytes/s), `net.down.total` / `net.up.total`
//!   (cumulative bytes, per-process lifetime — reset on restart, unlike a persisted counter).
//!   Primary-adapter detail (Windows, gated): `net.linkspeed.{rx,tx}` (bytes/s), `net.adapter`
//!   (text), `net.state` (text).
//! - Disks (gated, dynamic): capacity `disk.<letter>.{total,free,used}` (bytes) +
//!   `disk.<letter>.used.pct`; live I/O (Windows) `disk.<letter>.{read,write}` (bytes/s) +
//!   `disk.<letter>.busy.pct` (active time).
//! - Host: `host.uptime` (s), `host.procs` (count, gated), `host.idle` (s since last input, Windows),
//!   `host.handles` / `host.threads` (counts, Windows, gated).
//! - Processes (gated, per-metric): the busiest process by CPU — `proc.cpu.top.name` (text) +
//!   `proc.cpu.top.pct` (% of the whole machine); by RAM — `proc.mem.top.name` + `proc.mem.top.bytes`
//!   (RSS); by disk I/O — `proc.disk.top.name` + `proc.disk.top.bytes` (read+write bytes/s); and by GPU
//!   VRAM — `proc.gpu.top.name` + `proc.gpu.top.bytes` (NVML running-process VRAM). Each metric is only
//!   sampled while its widget is mounted.
//! - GPU (gated, NVIDIA/NVML): `gpu.util` / `gpu.mem.util` / `gpu.fan` (%), `gpu.vram` (%),
//!   `gpu.vram.{total,used,free}` (bytes), `gpu.temp` (°C), `gpu.clock.{core,mem}` (MHz),
//!   `gpu.power` / `gpu.power.limit` (W — NVML reports mW, divided here), `gpu.name` (text).
//! - Battery (Windows, only when present): `battery.percent` (%), `battery.state` (text),
//!   `battery.time` (s), `battery.rate` (W, signed), `battery.capacity.{full,remaining}` (Wh).
//!
//! The percent ids (`mem.used`, `swap.used`, `gpu.vram`) are kept for backward compat — the byte
//! absolutes are ADDED alongside, never renamed (templates + the ported skins bind the percents).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nvml_wrapper::{enum_wrappers::device::{Clock, TemperatureSensor}, Nvml};
use serde::Serialize;
use sysinfo::{Disks, Networks, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::log;

/// The `telemetry` event name on the Tauri bridge (re-exported so ha/mqtt/stocks keep importing
/// it from here; the string itself lives in bridge.rs with the rest of the contract).
pub use crate::bridge::TELEMETRY_EVENT;

/// A single metric value. Mirrors `SensorValue` in `core/telemetry.ts`.
///
/// `Series` / `Json` are part of the bridge contract but not produced here yet (per-core
/// series, media JSON), hence `dead_code` is allowed.
#[allow(dead_code)]
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "lowercase")]
pub enum SensorValue {
    Scalar(f64),
    Text(String),
    Series(Vec<f64>),
    Json(serde_json::Value),
}

/// One sample from one sensor. Mirrors `SensorSample` in `core/telemetry.ts`.
#[derive(Clone, Debug, Serialize)]
pub struct SensorSample {
    pub sensor: String,
    pub ts_ms: u64,
    pub value: SensorValue,
}

impl SensorSample {
    pub fn scalar(sensor: impl Into<String>, ts_ms: u64, value: f64) -> Self {
        SensorSample {
            sensor: sensor.into(),
            ts_ms,
            value: SensorValue::Scalar(value),
        }
    }

    pub fn text(sensor: impl Into<String>, ts_ms: u64, value: impl Into<String>) -> Self {
        SensorSample {
            sensor: sensor.into(),
            ts_ms,
            value: SensorValue::Text(value.into()),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Base sampling interval. Per-sensor intervals arrive later in Phase 1.
const INTERVAL_MS: u64 = 1000;

/// `used / total` as a 0..100 percentage. Returns 0 when `total` is 0.
fn percent(used: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        used as f64 * 100.0 / total as f64
    }
}

/// Convert a per-tick byte delta into a bytes-per-second rate.
fn rate_per_sec(bytes: u64, interval_ms: u64) -> f64 {
    if interval_ms == 0 {
        0.0
    } else {
        bytes as f64 * 1000.0 / interval_ms as f64
    }
}

/// Stable sensor id for a per-core CPU usage reading (zero-indexed).
fn core_sensor_id(index: usize) -> String {
    format!("cpu.core.{index}")
}

/// The `(name, value)` with the greatest value (NaN-safe), or `None` when empty. Pure seam for
/// picking the top process by CPU or memory.
fn top_of(items: &[(String, f64)]) -> Option<&(String, f64)> {
    items
        .iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
}

/// Extract `<name>` from a `proc.watch.<name>.{running,count,cpu,mem}` id (the Process Watcher binds
/// these). `None` otherwise. The name can contain dots ("Discord.exe"), so strip the fixed prefix +
/// suffix rather than splitting. Pure.
fn proc_watch_name_of(id: &str) -> Option<&str> {
    let rest = id.strip_prefix("proc.watch.")?;
    for suf in [".running", ".count", ".cpu", ".mem"] {
        if let Some(name) = rest.strip_suffix(suf) {
            return (!name.is_empty()).then_some(name);
        }
    }
    None
}

/// The distinct watched process names from the active set (sorted, deduped). Pure.
fn proc_watch_names(active: &HashMap<String, HashSet<String>>) -> Vec<String> {
    let mut set: HashSet<&str> = HashSet::new();
    for ids in active.values() {
        for id in ids {
            if let Some(n) = proc_watch_name_of(id) {
                set.insert(n);
            }
        }
    }
    let mut v: Vec<String> = set.into_iter().map(str::to_string).collect();
    v.sort();
    v
}

/// Case-insensitive process-name match, tolerant of a present/absent ".exe" on either side (so a
/// config of "chrome" or "chrome.exe" both match the "chrome.exe" sysinfo reports). Pure.
fn name_matches(proc_name: &str, watched: &str) -> bool {
    let n = proc_name.to_lowercase();
    let w = watched.to_lowercase();
    n.strip_suffix(".exe").unwrap_or(&n) == w.strip_suffix(".exe").unwrap_or(&w)
}

/// Flatten the latest-value map to a `{ id: number|string }` JSON object — Scalar and Text only
/// (Series/Json are dropped; not useful in a flat snapshot). Pure seam for the MCP live-state file.
fn flatten_latest(latest: &HashMap<String, SensorValue>) -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    for (id, v) in latest {
        match v {
            SensorValue::Scalar(n) => {
                out.insert(id.clone(), serde_json::json!(n));
            }
            SensorValue::Text(t) => {
                out.insert(id.clone(), serde_json::json!(t));
            }
            _ => {}
        }
    }
    out
}

/// Mirror the latest sensor values to `<app_config_dir>/mcp/state.json` so the (out-of-process) MCP
/// server can read LIVE readings — the file-based MCP can't reach this in-memory state otherwise.
/// Written to an `mcp/` SUBDIR so the NonRecursive config-dir watchers never see it. Best-effort.
fn write_state_snapshot<R: Runtime>(app: &AppHandle<R>, latest: &HashMap<String, SensorValue>) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let mcp_dir = dir.join("mcp");
    if std::fs::create_dir_all(&mcp_dir).is_err() {
        return;
    }
    let snapshot = serde_json::json!({
        "ts_ms": now_ms(),
        "sensors": flatten_latest(latest),
    });
    if let Ok(txt) = serde_json::to_string(&snapshot) {
        let _ = std::fs::write(mcp_dir.join("state.json"), txt);
    }
}

/// The lowercased drive-letter slug for a volume's mount point, e.g. `C:\` → `"c"`. Used to build
/// the dynamic per-disk sensor ids (`disk.<letter>.{total,free,used,used.pct}`). Volumes whose
/// mount point doesn't begin with a letter (rare on Windows) are skipped (returns None).
fn disk_letter(mount: &Path) -> Option<String> {
    let first = mount.to_string_lossy().chars().next()?;
    first
        .is_ascii_alphabetic()
        .then(|| first.to_ascii_lowercase().to_string())
}

/// Win32 `BatteryFlag`: 128 = no system battery (desktop), 255 = unknown / can't read. Treat both
/// as "no battery present" so desktops emit no `battery.*` samples at all.
fn battery_present(flag: u8) -> bool {
    flag != 128 && flag != 255
}

/// Win32 `BatteryLifePercent`: 0..=100, or 255 when unknown → `None`.
fn battery_percent(p: u8) -> Option<f64> {
    (p <= 100).then(|| f64::from(p))
}

/// Win32 `BatteryLifeTime`: seconds of runtime left, or `u32::MAX` (-1) when unknown / on AC → `None`.
fn battery_seconds(t: u32) -> Option<u64> {
    (t != u32::MAX).then(|| u64::from(t))
}

/// A short battery state label from `ACLineStatus` (0 offline, 1 online) and `BatteryFlag`
/// (bit 8 = charging). Charging wins; otherwise on-AC vs discharging by the line status.
fn battery_state(ac_line: u8, flag: u8) -> &'static str {
    if flag & 8 != 0 {
        "charging"
    } else if ac_line == 1 {
        "ac"
    } else if ac_line == 0 {
        "discharging"
    } else {
        "unknown"
    }
}

/// Sample the battery via the Win32 power API. Returns the samples to append, or empty when there
/// is no system battery (desktops) or the call fails. The `GetSystemPowerStatus` syscall is cheap,
/// so this runs every tick (presence-gated) rather than via the active-set gate.
#[cfg(target_os = "windows")]
fn battery_samples(ts: u64) -> Vec<SensorSample> {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    let mut status = SYSTEM_POWER_STATUS::default();
    // SAFETY: GetSystemPowerStatus fills a plain owned POD struct; no aliasing, no lifetime concern.
    if unsafe { GetSystemPowerStatus(&mut status) }.is_err() || !battery_present(status.BatteryFlag)
    {
        return Vec::new();
    }
    let mut out = vec![SensorSample::text(
        "battery.state",
        ts,
        battery_state(status.ACLineStatus, status.BatteryFlag),
    )];
    if let Some(p) = battery_percent(status.BatteryLifePercent) {
        out.push(SensorSample::scalar("battery.percent", ts, p));
    }
    if let Some(secs) = battery_seconds(status.BatteryLifeTime) {
        out.push(SensorSample::scalar("battery.time", ts, secs as f64));
    }
    out
}

/// Non-Windows builds have no battery source.
#[cfg(not(target_os = "windows"))]
fn battery_samples(_ts: u64) -> Vec<SensorSample> {
    Vec::new()
}

/// Page-count × page-size → bytes. `PERFORMANCE_INFORMATION` reports memory in pages, so the
/// commit/cache/kernel-pool fields multiply by `PageSize` (the count fields — handles/threads — do
/// not). Saturating so a pathological product can't wrap.
fn bytes_from_pages(pages: usize, page_size: usize) -> f64 {
    (pages as u64).saturating_mul(page_size as u64) as f64
}

/// Seconds since the last input event, from a 64-bit tick count and the 32-bit
/// `LASTINPUTINFO.dwTime` (a `GetTickCount` value in ms, which wraps every ~49.7 days). The
/// wrapping subtraction on the low 32 bits yields the correct elapsed ms across a wrap.
fn idle_seconds_from(tick_now_ms: u64, last_input_ms: u32) -> u64 {
    u64::from((tick_now_ms as u32).wrapping_sub(last_input_ms)) / 1000
}

/// Windows commit-charge / cache / kernel-pool / handle / thread sensors, from one
/// `GetPerformanceInfo` call. Net-new vs sysinfo (which calls the same API but only derives swap).
#[cfg(target_os = "windows")]
fn perf_info_samples(ts: u64) -> Vec<SensorSample> {
    use windows::Win32::System::ProcessStatus::{GetPerformanceInfo, PERFORMANCE_INFORMATION};

    let cb = std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32;
    let mut pi = PERFORMANCE_INFORMATION { cb, ..Default::default() };
    // SAFETY: pi is a valid owned struct and cb is its byte size; GetPerformanceInfo fills it.
    if unsafe { GetPerformanceInfo(&mut pi, cb) }.is_err() {
        return Vec::new();
    }
    let page = pi.PageSize;
    vec![
        SensorSample::scalar("mem.commit.used", ts, bytes_from_pages(pi.CommitTotal, page)),
        SensorSample::scalar("mem.commit.limit", ts, bytes_from_pages(pi.CommitLimit, page)),
        SensorSample::scalar("mem.commit.peak", ts, bytes_from_pages(pi.CommitPeak, page)),
        SensorSample::scalar("mem.cached", ts, bytes_from_pages(pi.SystemCache, page)),
        SensorSample::scalar("mem.kernel.paged", ts, bytes_from_pages(pi.KernelPaged, page)),
        SensorSample::scalar("mem.kernel.nonpaged", ts, bytes_from_pages(pi.KernelNonpaged, page)),
        SensorSample::scalar("host.handles", ts, f64::from(pi.HandleCount)),
        SensorSample::scalar("host.threads", ts, f64::from(pi.ThreadCount)),
    ]
}

#[cfg(not(target_os = "windows"))]
fn perf_info_samples(_ts: u64) -> Vec<SensorSample> {
    Vec::new()
}

/// Live per-core / summary CPU clock (MHz) from `CallNtPowerInformation(ProcessorInformation)`.
/// `cpu.freq.current` is the max live (turbo) clock across cores — sysinfo's `cpu.freq` only reports
/// the BASE clock on Windows, so this is the boost clock it can't give. One array call fills the lot.
///
/// Single processor group only: on machines with >64 logical CPUs the call fills just the calling
/// group, so cores beyond it read 0 MHz. Fine for desktops (≤64); not worth multi-group plumbing.
#[cfg(target_os = "windows")]
fn cpu_freq_samples(ts: u64, logical_cores: usize) -> Vec<SensorSample> {
    use windows::Win32::System::Power::{
        CallNtPowerInformation, ProcessorInformation, PROCESSOR_POWER_INFORMATION,
    };

    if logical_cores == 0 {
        return Vec::new();
    }
    let mut info = vec![PROCESSOR_POWER_INFORMATION::default(); logical_cores];
    let out_len = (std::mem::size_of::<PROCESSOR_POWER_INFORMATION>() * logical_cores) as u32;
    // SAFETY: the output buffer is `logical_cores` contiguous PROCESSOR_POWER_INFORMATION and
    // `out_len` is its exact byte length; there is no input buffer.
    let status = unsafe {
        CallNtPowerInformation(
            ProcessorInformation,
            None,
            0,
            Some(info.as_mut_ptr().cast()),
            out_len,
        )
    };
    if status.0 != 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(logical_cores + 2);
    let mut current_max = 0u32;
    let mut rated_max = 0u32;
    for p in &info {
        out.push(SensorSample::scalar(
            format!("cpu.core.{}.freq", p.Number),
            ts,
            f64::from(p.CurrentMhz),
        ));
        current_max = current_max.max(p.CurrentMhz);
        rated_max = rated_max.max(p.MaxMhz);
    }
    out.push(SensorSample::scalar("cpu.freq.current", ts, f64::from(current_max)));
    out.push(SensorSample::scalar("cpu.freq.max", ts, f64::from(rated_max)));
    out
}

#[cfg(not(target_os = "windows"))]
fn cpu_freq_samples(_ts: u64, _logical_cores: usize) -> Vec<SensorSample> {
    Vec::new()
}

/// Seconds since the last keyboard/mouse input (Windows), via `GetLastInputInfo` + `GetTickCount64`.
/// `None` on failure / non-Windows. A cheap, always-on AFK signal.
#[cfg(target_os = "windows")]
fn idle_seconds() -> Option<u64> {
    use windows::Win32::System::SystemInformation::GetTickCount64;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut lii = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: lii is a valid owned struct with cbSize set; GetLastInputInfo fills dwTime.
    if unsafe { GetLastInputInfo(&mut lii) }.as_bool() {
        // SAFETY: a plain monotonic counter read, no pointers involved.
        Some(idle_seconds_from(unsafe { GetTickCount64() }, lii.dwTime))
    } else {
        None
    }
}

#[cfg(not(target_os = "windows"))]
fn idle_seconds() -> Option<u64> {
    None
}

/// A snapshot of one volume's cumulative I/O counters (`DISK_PERFORMANCE`), kept between ticks so
/// rates and active-time can be derived from deltas. Times are in 100ns units; bytes are cumulative.
#[derive(Clone, Copy, Default)]
struct DiskIo {
    idle: i64,
    query: i64,
    read: i64,
    written: i64,
}

/// Disk active-time percent over an interval: `1 - idle/elapsed`, clamped to 0..100. `delta_query`
/// is the elapsed 100ns ticks, `delta_idle` the idle 100ns ticks within it.
fn busy_pct(delta_idle: i64, delta_query: i64) -> f64 {
    if delta_query <= 0 {
        return 0.0;
    }
    let active = 1.0 - (delta_idle as f64 / delta_query as f64);
    active.clamp(0.0, 1.0) * 100.0
}

/// Per-disk I/O sensors from a previous and current counter snapshot: `disk.<letter>.busy.pct`
/// (active time) and `disk.<letter>.read` / `.write` (bytes/sec). Pure — the Win32 read is separate.
///
/// The rate denominator is the volume's own `QueryTime` delta (a 100ns system-time stamp captured
/// in the same IOCTL as the byte counters), NOT a fixed tick — so when the I/O gate has been off for
/// a while the byte delta is divided by the real elapsed time it accrued over, never inflating into
/// a spike on the first tick after a gap. `busy.pct` already self-normalizes on the same delta.
fn disk_io_samples_for(letter: &str, ts: u64, prev: DiskIo, cur: DiskIo) -> Vec<SensorSample> {
    let delta_query = cur.query - prev.query; // 100ns ticks of real time between the two snapshots
    let elapsed_ms = (delta_query / 10_000).max(0) as u64;
    vec![
        SensorSample::scalar(
            format!("disk.{letter}.busy.pct"),
            ts,
            busy_pct(cur.idle - prev.idle, delta_query),
        ),
        SensorSample::scalar(
            format!("disk.{letter}.read"),
            ts,
            rate_per_sec((cur.read - prev.read).max(0) as u64, elapsed_ms),
        ),
        SensorSample::scalar(
            format!("disk.{letter}.write"),
            ts,
            rate_per_sec((cur.written - prev.written).max(0) as u64, elapsed_ms),
        ),
    ]
}

/// Decode a NUL-terminated fixed-size UTF-16 buffer (e.g. `MIB_IF_ROW2.Alias`) to a `String`.
fn utf16_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

/// Read one volume's cumulative I/O counters via `DeviceIoControl(IOCTL_DISK_PERFORMANCE)`. The
/// volume handle is opened with zero access rights (no admin needed). `None` on any failure.
#[cfg(target_os = "windows")]
fn read_disk_io(letter: &str) -> Option<DiskIo> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_MODE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };
    use windows::Win32::System::Ioctl::{DISK_PERFORMANCE, IOCTL_DISK_PERFORMANCE};
    use windows::Win32::System::IO::DeviceIoControl;

    let path: Vec<u16> = format!("\\\\.\\{}:", letter.to_uppercase())
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `path` is a NUL-terminated UTF-16 string; CreateFileW returns Err on an invalid handle.
    let handle = unsafe {
        CreateFileW(
            PCWSTR(path.as_ptr()),
            0,
            FILE_SHARE_MODE(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0),
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
    }
    .ok()?;

    let mut perf = DISK_PERFORMANCE::default();
    let mut returned = 0u32;
    // SAFETY: `perf` is a valid owned buffer of the stated size; `handle` is open.
    let res = unsafe {
        DeviceIoControl(
            handle,
            IOCTL_DISK_PERFORMANCE,
            None,
            0,
            Some(std::ptr::from_mut(&mut perf).cast()),
            std::mem::size_of::<DISK_PERFORMANCE>() as u32,
            Some(&mut returned),
            None,
        )
    };
    // SAFETY: close the handle we opened, whatever the IOCTL returned.
    unsafe {
        let _ = CloseHandle(handle);
    }
    res.ok()?;
    Some(DiskIo {
        idle: perf.IdleTime,
        query: perf.QueryTime,
        read: perf.BytesRead,
        written: perf.BytesWritten,
    })
}

#[cfg(not(target_os = "windows"))]
fn read_disk_io(_letter: &str) -> Option<DiskIo> {
    None
}

/// Battery power/energy from `CallNtPowerInformation(SystemBatteryState)`: `battery.rate` (watts,
/// signed — negative = discharging) and `battery.capacity.{full,remaining}` (watt-hours). Empty when
/// no battery is present. Complements the `GetSystemPowerStatus` figures in `battery_samples`.
#[cfg(target_os = "windows")]
fn battery_power_samples(ts: u64) -> Vec<SensorSample> {
    use windows::Win32::System::Power::{
        CallNtPowerInformation, SystemBatteryState, SYSTEM_BATTERY_STATE,
    };

    // SAFETY: a zeroed POD output buffer, filled by CallNtPowerInformation.
    let mut sbs: SYSTEM_BATTERY_STATE = unsafe { std::mem::zeroed() };
    let status = unsafe {
        CallNtPowerInformation(
            SystemBatteryState,
            None,
            0,
            Some(std::ptr::from_mut(&mut sbs).cast()),
            std::mem::size_of::<SYSTEM_BATTERY_STATE>() as u32,
        )
    };
    if status.0 != 0 || !sbs.BatteryPresent {
        return Vec::new();
    }
    let mut out = Vec::new();
    // Rate is mW, signed (reinterpret the u32 as i32); 0x8000_0000 is the "unknown" sentinel.
    let rate = sbs.Rate as i32;
    if rate != i32::MIN {
        out.push(SensorSample::scalar("battery.rate", ts, f64::from(rate) / 1000.0));
    }
    if sbs.MaxCapacity != u32::MAX {
        out.push(SensorSample::scalar("battery.capacity.full", ts, f64::from(sbs.MaxCapacity) / 1000.0));
    }
    if sbs.RemainingCapacity != u32::MAX {
        out.push(SensorSample::scalar(
            "battery.capacity.remaining",
            ts,
            f64::from(sbs.RemainingCapacity) / 1000.0,
        ));
    }
    out
}

#[cfg(not(target_os = "windows"))]
fn battery_power_samples(_ts: u64) -> Vec<SensorSample> {
    Vec::new()
}

/// Link speed / adapter / connection state of the primary network interface, via one `GetIfTable2`
/// walk. `net.linkspeed.{rx,tx}` are bytes/sec (link speed is bits/s → ÷8, so it's the natural
/// denominator for a `net.down`/`net.up` utilisation bar). `net.state` is always emitted; the
/// primary is the connected, operational adapter with the highest receive link speed.
#[cfg(target_os = "windows")]
fn net_link_samples(ts: u64) -> Vec<SensorSample> {
    use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
    use windows::Win32::NetworkManagement::Ndis::{IfOperStatusUp, MediaConnectStateConnected};

    let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
    // SAFETY: GetIfTable2 allocates the table and writes its pointer; we FreeMibTable it below.
    if unsafe { GetIfTable2(&mut table) }.0 != 0 || table.is_null() {
        return Vec::new();
    }
    // SAFETY: on success `table` points to a MIB_IF_TABLE2 followed by `NumEntries` rows.
    let rows = unsafe {
        std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize)
    };
    let any_connected = rows
        .iter()
        .any(|r| r.MediaConnectState == MediaConnectStateConnected);
    let best = rows
        .iter()
        .filter(|r| {
            r.OperStatus == IfOperStatusUp
                && r.MediaConnectState == MediaConnectStateConnected
                && r.ReceiveLinkSpeed > 0
        })
        .max_by_key(|r| (r.ReceiveLinkSpeed, r.InOctets));
    let mut out = vec![SensorSample::text(
        "net.state",
        ts,
        if any_connected { "connected" } else { "disconnected" },
    )];
    if let Some(r) = best {
        out.push(SensorSample::scalar("net.linkspeed.rx", ts, (r.ReceiveLinkSpeed / 8) as f64));
        out.push(SensorSample::scalar("net.linkspeed.tx", ts, (r.TransmitLinkSpeed / 8) as f64));
        let name = utf16_to_string(&r.Alias);
        if !name.is_empty() {
            out.push(SensorSample::text("net.adapter", ts, name));
        }
    }
    // SAFETY: free the table allocated by GetIfTable2 (every value we keep is already copied out).
    unsafe { FreeMibTable(table.cast()) };
    out
}

#[cfg(not(target_os = "windows"))]
fn net_link_samples(_ts: u64) -> Vec<SensorSample> {
    Vec::new()
}

/// Per-window record of which sensor ids are currently being consumed, keyed by
/// `window.label()`. Demand-gating reads this to decide whether the expensive NVML / disk /
/// process queries are worth running this tick (see `any_wanted`).
///
/// A plain `std::sync::Mutex` (locks are brief and synchronous — never held across an
/// `.await`). Managed in `main.rs` and updated by the `set_active_sensors` command.
#[derive(Default)]
pub struct ActiveSensors(pub Mutex<HashMap<String, HashSet<String>>>);

/// Record the set of sensor ids window `window.label()` is currently consuming.
///
/// The frontend calls `invoke("set_active_sensors", { ids })` whenever its set of
/// mounted sensors changes; a set containing `"*"` is a sentinel meaning "everything".
#[tauri::command]
pub async fn set_active_sensors<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, ActiveSensors>,
    ids: Vec<String>,
) -> Result<(), ()> {
    let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
    map.insert(window.label().to_string(), ids.into_iter().collect());
    Ok(())
}

/// True if any window's active set wants a sensor matching `pred`. Default-ON for safety: a match
/// counts when the union of every window's reported set is EMPTY (nobody has reported yet, so don't
/// blank sensors at startup), OR any window asked for everything (`"*"`), OR any window's id
/// satisfies `pred`.
pub(crate) fn any_wanted(active: &HashMap<String, HashSet<String>>, pred: impl Fn(&str) -> bool) -> bool {
    if active.values().all(|ids| ids.is_empty()) {
        return true;
    }
    active
        .values()
        .any(|ids| ids.contains("*") || ids.iter().any(|id| pred(id)))
}

/// Should the GPU be sampled this tick? Any active `gpu.*` id (or the `"*"` wildcard) turns the
/// whole NVML block on; nothing else pays for it. A prefix test (not a fixed id list) so new
/// `gpu.*` sensors are covered automatically.
fn gpu_wanted(active: &HashMap<String, HashSet<String>>) -> bool {
    any_wanted(active, |id| id.starts_with("gpu."))
}

/// Per-metric demand for the "top process" sensors (`proc.<metric>.top.*`). The (gated, expensive)
/// process refresh runs when ANY of these is set; each metric is then emitted only when its own widget
/// is mounted, so a Top-Process(disk) widget never pays to compute the CPU/RAM/GPU tops. The GPU top
/// additionally enumerates NVML's running-process list, so it's gated on `gpu` alone.
#[derive(Clone, Copy, Default)]
struct ProcWants {
    cpu: bool,
    mem: bool,
    disk: bool,
    gpu: bool,
}
impl ProcWants {
    fn any(&self) -> bool {
        self.cpu || self.mem || self.disk || self.gpu
    }
}

/// Ids served by the single `GetPerformanceInfo` call (commit charge / cache / kernel pools /
/// handle + thread totals). Gated as a group so the syscall + 8 samples are skipped when unused.
fn is_perf_id(id: &str) -> bool {
    id.starts_with("mem.commit.")
        || id == "mem.cached"
        || id.starts_with("mem.kernel.")
        || id == "host.handles"
        || id == "host.threads"
}

/// Ids served by the single `CallNtPowerInformation(ProcessorInformation)` call (live summary +
/// per-core CPU clock). Gated so the per-tick buffer alloc + syscall are skipped when unused.
fn is_cpufreq_id(id: &str) -> bool {
    id == "cpu.freq.current"
        || id == "cpu.freq.max"
        || (id.starts_with("cpu.core.") && id.ends_with(".freq"))
}

/// Per-disk live I/O ids (active time + read/write throughput). Distinct from the capacity ids
/// (`disk.<letter>.{total,free,used,used.pct}`) so the per-tick volume-handle + IOCTL is skipped
/// unless an I/O meter is mounted.
fn is_disk_io_id(id: &str) -> bool {
    id.starts_with("disk.")
        && (id.ends_with(".busy.pct") || id.ends_with(".read") || id.ends_with(".write"))
}

/// Ids served by the `GetIfTable2` walk (link speed / adapter / connection state). Gated so the
/// interface-table enumeration is skipped when no network-link meter is mounted.
fn is_netlink_id(id: &str) -> bool {
    id.starts_with("net.linkspeed") || id == "net.adapter" || id == "net.state"
}

/// Ids served by the WLAN query (SSID / signal / channel / PHY). Gated so the WLAN handle is only
/// opened when a Wi-Fi meter is mounted.
fn is_wifi_id(id: &str) -> bool {
    id.starts_with("net.wifi")
}

/// Poll system sensors on an interval and emit a `telemetry` batch each tick.
///
/// Cheap, always-on sensors (CPU usage + per-core, memory, swap, network, host counts/uptime) emit
/// every tick. Expensive ones are demand-gated: the NVML block, per-disk enumeration, the process
/// table refresh and the CPU-frequency refresh only run when a matching sensor is mounted (or the
/// studio asked for `"*"`). CPU usage needs two refreshes spaced apart to be non-zero, so init
/// primes it. NVML is optional: if init fails (no NVIDIA driver) GPU sensors are skipped without
/// erroring. Runs until the app exits.
pub async fn run_system_sensors<R: Runtime>(app: AppHandle<R>) {
    let mut sys = System::new();
    sys.refresh_cpu_all(); // primes usage + frequency, and loads static CPU info (brand)
    sys.refresh_memory();
    let mut networks = Networks::new_with_refreshed_list();
    let mut disks = Disks::new_with_refreshed_list();
    // Previous per-volume I/O counters, keyed by drive letter — disk rates/active-time are deltas.
    let mut disk_io_prev: HashMap<String, DiskIo> = HashMap::new();

    // Static host facts, read once.
    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .filter(|s| !s.is_empty());
    let logical_cores = sys.cpus().len();
    let physical_cores = sys.physical_core_count();

    // GPU is best-effort: degrade gracefully on machines without NVML/NVIDIA.
    let nvml = match Nvml::init() {
        Ok(nvml) => Some(nvml),
        Err(err) => {
            log::warn("sensors", "GPU sensors disabled (NVML init failed)")
                .field("error", err)
                .emit();
            None
        }
    };
    let gpu = nvml.as_ref().and_then(|nvml| nvml.device_by_index(0).ok());
    let gpu_name = gpu
        .as_ref()
        .and_then(|d| d.name().ok())
        .filter(|s| !s.is_empty());

    // Latest value per sensor id, mirrored to <config>/mcp/state.json every few ticks for the MCP
    // server's read_sensors tool (live readings for an external agent).
    let mut latest: HashMap<String, SensorValue> = HashMap::new();
    let mut snap_tick: u32 = 0;

    // Opt-in per-subsystem CPU timing for the Diagnostics panel (inert unless the panel enabled it).
    let timings = app.state::<crate::timings::SubsystemTimings>();

    let mut ticker = tokio::time::interval(Duration::from_millis(INTERVAL_MS));
    loop {
        ticker.tick().await;
        {
            let _t = timings.start("sensors.base");
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            networks.refresh(true);
        }

        let ts = now_ms();

        let total_mem = sys.total_memory();
        let used_mem = sys.used_memory();
        let total_swap = sys.total_swap();
        let used_swap = sys.used_swap();

        let down: u64 = networks.values().map(|d| d.received()).sum();
        let up: u64 = networks.values().map(|d| d.transmitted()).sum();
        let down_total: u64 = networks.values().map(|d| d.total_received()).sum();
        let up_total: u64 = networks.values().map(|d| d.total_transmitted()).sum();

        let mut batch = vec![
            // CPU
            SensorSample::scalar("cpu.total", ts, f64::from(sys.global_cpu_usage())),
            SensorSample::scalar("cpu.cores.logical", ts, logical_cores as f64),
            // Memory: percent (back-compat) + absolute bytes
            SensorSample::scalar("mem.used", ts, percent(used_mem, total_mem)),
            SensorSample::scalar("mem.total", ts, total_mem as f64),
            SensorSample::scalar("mem.used.bytes", ts, used_mem as f64),
            SensorSample::scalar("mem.available", ts, sys.available_memory() as f64),
            SensorSample::scalar("mem.free", ts, sys.free_memory() as f64),
            // Swap / page file: percent (back-compat) + absolute bytes
            SensorSample::scalar("swap.used", ts, percent(used_swap, total_swap)),
            SensorSample::scalar("swap.total", ts, total_swap as f64),
            SensorSample::scalar("swap.used.bytes", ts, used_swap as f64),
            SensorSample::scalar("swap.free", ts, sys.free_swap() as f64),
            // Network: live rates + cumulative byte counters
            SensorSample::scalar("net.down", ts, rate_per_sec(down, INTERVAL_MS)),
            SensorSample::scalar("net.up", ts, rate_per_sec(up, INTERVAL_MS)),
            SensorSample::scalar("net.total", ts, rate_per_sec(down + up, INTERVAL_MS)),
            SensorSample::scalar("net.down.total", ts, down_total as f64),
            SensorSample::scalar("net.up.total", ts, up_total as f64),
            // Host
            SensorSample::scalar("host.uptime", ts, System::uptime() as f64),
        ];

        if let Some(p) = physical_cores {
            batch.push(SensorSample::scalar("cpu.cores.physical", ts, p as f64));
        }
        if let Some(brand) = &cpu_brand {
            batch.push(SensorSample::text("cpu.brand", ts, brand.clone()));
        }

        for (i, cpu) in sys.cpus().iter().enumerate() {
            batch.push(SensorSample::scalar(core_sensor_id(i), ts, f64::from(cpu.cpu_usage())));
        }

        // Compute all demand-gates under ONE brief lock, then DROP it before any expensive I/O
        // (NVML, process enumeration, disk refresh, frequency refresh) — the std Mutex must never be
        // held across an await or a blocking driver call.
        #[allow(clippy::type_complexity)]
        let (want_gpu, want_disks, want_disk_io, want_procs, proc_w, proc_watch, want_freq, want_perf, want_cpufreq, want_netlink, want_conns, want_wifi, want_recyclebin) = {
            let active: tauri::State<ActiveSensors> = app.state();
            let g = active.0.lock().unwrap_or_else(|e| e.into_inner());
            let pw = |p: &str| any_wanted(&g, |id| id.starts_with(p));
            (
                gpu_wanted(&g),
                any_wanted(&g, |id| id.starts_with("disk.")),
                any_wanted(&g, is_disk_io_id),
                any_wanted(&g, |id| id == "host.procs"),
                ProcWants {
                    cpu: pw("proc.cpu.top"),
                    mem: pw("proc.mem.top"),
                    disk: pw("proc.disk.top"),
                    gpu: pw("proc.gpu.top"),
                },
                proc_watch_names(&g),
                any_wanted(&g, |id| id == "cpu.freq"),
                any_wanted(&g, is_perf_id),
                any_wanted(&g, is_cpufreq_id),
                any_wanted(&g, is_netlink_id),
                any_wanted(&g, |id| id.starts_with("net.conn")),
                any_wanted(&g, is_wifi_id),
                any_wanted(&g, |id| id.starts_with("recyclebin")),
            )
        };
        let want_proctop = proc_w.any();

        // host.idle is a single cheap syscall — always-on, like host.uptime / battery.
        if let Some(secs) = idle_seconds() {
            batch.push(SensorSample::scalar("host.idle", ts, secs as f64));
        }

        if want_freq {
            sys.refresh_cpu_frequency();
            if let Some(cpu) = sys.cpus().first() {
                batch.push(SensorSample::scalar("cpu.freq", ts, cpu.frequency() as f64));
            }
        }

        if want_procs || want_proctop || !proc_watch.is_empty() {
            let _t = timings.start("sensors.process");
            let n = sys.refresh_processes(ProcessesToUpdate::All, true);
            if want_procs {
                batch.push(SensorSample::scalar("host.procs", ts, n as f64));
            }
            // sysinfo's per-process cpu_usage sums across cores (can exceed 100%); divide by the logical
            // core count so it reads as "% of the whole machine", like cpu.total. Shared by top + watch.
            let ncpu = sys.cpus().len().max(1) as f64;

            // Process Watcher: for each watched name, aggregate every matching process (a browser has
            // many) into a running flag + summed CPU% + summed RAM + a count.
            for watched in &proc_watch {
                let mut cpu = 0.0_f64;
                let mut mem = 0.0_f64;
                let mut count = 0u32;
                for proc in sys.processes().values() {
                    if name_matches(&proc.name().to_string_lossy(), watched) {
                        cpu += proc.cpu_usage() as f64 / ncpu;
                        mem += proc.memory() as f64;
                        count += 1;
                    }
                }
                batch.push(SensorSample::scalar(
                    format!("proc.watch.{watched}.running"),
                    ts,
                    if count > 0 { 1.0 } else { 0.0 },
                ));
                batch.push(SensorSample::scalar(format!("proc.watch.{watched}.count"), ts, count as f64));
                if count > 0 {
                    batch.push(SensorSample::scalar(format!("proc.watch.{watched}.cpu"), ts, cpu));
                    batch.push(SensorSample::scalar(format!("proc.watch.{watched}.mem"), ts, mem));
                }
            }

            if want_proctop {
                // The busiest process by CPU / RAM / disk I/O — the "what's eating my machine" sensors.
                // One pass builds only the rankings whose widget is mounted (proc_w.*). disk_usage is the
                // read+written bytes since the last refresh (~1 s) — a per-tick rate.
                let mut by_cpu: Vec<(String, f64)> = Vec::new();
                let mut by_mem: Vec<(String, f64)> = Vec::new();
                let mut by_disk: Vec<(String, f64)> = Vec::new();
                for proc in sys.processes().values() {
                    let name = proc.name().to_string_lossy().to_string();
                    if name.is_empty() {
                        continue;
                    }
                    if proc_w.cpu {
                        by_cpu.push((name.clone(), proc.cpu_usage() as f64 / ncpu));
                    }
                    if proc_w.mem {
                        by_mem.push((name.clone(), proc.memory() as f64));
                    }
                    if proc_w.disk {
                        let du = proc.disk_usage();
                        by_disk.push((name, (du.read_bytes + du.written_bytes) as f64));
                    }
                }
                // Skip the first gated tick's misleading sample: sysinfo CPU% needs two refreshes, so
                // the first reads 0 for every process and top_of would pick an arbitrary one. Emit only
                // once there's a real (>0) busiest process; memory is valid from the first refresh.
                if proc_w.cpu
                    && let Some((name, pct)) = top_of(&by_cpu)
                    && *pct > 0.0
                {
                    batch.push(SensorSample::text("proc.cpu.top.name", ts, name.clone()));
                    batch.push(SensorSample::scalar("proc.cpu.top.pct", ts, *pct));
                }
                if proc_w.mem
                    && let Some((name, bytes)) = top_of(&by_mem)
                {
                    batch.push(SensorSample::text("proc.mem.top.name", ts, name.clone()));
                    batch.push(SensorSample::scalar("proc.mem.top.bytes", ts, *bytes));
                }
                // Like CPU, disk deltas read 0 on the first refresh — emit only once there's real I/O.
                if proc_w.disk
                    && let Some((name, bytes)) = top_of(&by_disk)
                    && *bytes > 0.0
                {
                    batch.push(SensorSample::text("proc.disk.top.name", ts, name.clone()));
                    batch.push(SensorSample::scalar("proc.disk.top.bytes", ts, *bytes));
                }
            }
        }

        if want_disks || want_disk_io {
            let _t = timings.start("sensors.disk");
            disks.refresh(true);
            for disk in disks.list() {
                let Some(letter) = disk_letter(disk.mount_point()) else {
                    continue;
                };
                if want_disks {
                    let total = disk.total_space();
                    let avail = disk.available_space();
                    let used = total.saturating_sub(avail);
                    batch.push(SensorSample::scalar(format!("disk.{letter}.total"), ts, total as f64));
                    batch.push(SensorSample::scalar(format!("disk.{letter}.free"), ts, avail as f64));
                    batch.push(SensorSample::scalar(format!("disk.{letter}.used"), ts, used as f64));
                    batch.push(SensorSample::scalar(
                        format!("disk.{letter}.used.pct"),
                        ts,
                        percent(used, total),
                    ));
                }
                // Live I/O needs a previous snapshot for the delta — first sighting just seeds it.
                if want_disk_io && let Some(cur) = read_disk_io(&letter) {
                    if let Some(&prev) = disk_io_prev.get(&letter) {
                        batch.extend(disk_io_samples_for(&letter, ts, prev, cur));
                    }
                    disk_io_prev.insert(letter, cur);
                }
            }
        }

        if want_gpu && let Some(device) = &gpu {
            let _t = timings.start("sensors.gpu");
            if let Ok(util) = device.utilization_rates() {
                batch.push(SensorSample::scalar("gpu.util", ts, f64::from(util.gpu)));
                batch.push(SensorSample::scalar("gpu.mem.util", ts, f64::from(util.memory)));
            }
            if let Ok(mem) = device.memory_info() {
                batch.push(SensorSample::scalar("gpu.vram", ts, percent(mem.used, mem.total)));
                batch.push(SensorSample::scalar("gpu.vram.total", ts, mem.total as f64));
                batch.push(SensorSample::scalar("gpu.vram.used", ts, mem.used as f64));
                batch.push(SensorSample::scalar("gpu.vram.free", ts, mem.free as f64));
            }
            if let Ok(temp) = device.temperature(TemperatureSensor::Gpu) {
                batch.push(SensorSample::scalar("gpu.temp", ts, f64::from(temp)));
            }
            if let Ok(mhz) = device.clock_info(Clock::Graphics) {
                batch.push(SensorSample::scalar("gpu.clock.core", ts, f64::from(mhz)));
            }
            if let Ok(mhz) = device.clock_info(Clock::Memory) {
                batch.push(SensorSample::scalar("gpu.clock.mem", ts, f64::from(mhz)));
            }
            // NVML reports power in milliwatts; emit watts. NotSupported on some boards → skip.
            if let Ok(mw) = device.power_usage() {
                batch.push(SensorSample::scalar("gpu.power", ts, f64::from(mw) / 1000.0));
            }
            if let Ok(mw) = device.enforced_power_limit() {
                batch.push(SensorSample::scalar("gpu.power.limit", ts, f64::from(mw) / 1000.0));
            }
            // fan_speed is a driver setpoint percent; frequently NotSupported on laptop GPUs.
            if let Ok(pct) = device.fan_speed(0) {
                batch.push(SensorSample::scalar("gpu.fan", ts, f64::from(pct)));
            }
            if let Some(name) = &gpu_name {
                batch.push(SensorSample::text("gpu.name", ts, name.clone()));
            }
            if proc_w.gpu {
                // Top process by GPU VRAM. NVML's running-process lists give (pid, used VRAM); the pid
                // → name comes from the process table refreshed above (proc.gpu.top is a `proc.*` id, so
                // want_proctop ran the refresh). Graphics + compute lists are merged (a pid can be in
                // both); the hungriest wins. Util-per-process needs a fragile timestamp API, so VRAM —
                // reliably reported — is the rank.
                use nvml_wrapper::enums::device::UsedGpuMemory;
                let mut procs = device.running_graphics_processes().unwrap_or_default();
                procs.extend(device.running_compute_processes().unwrap_or_default());
                let mut seen: HashSet<u32> = HashSet::new();
                let mut by_vram: Vec<(String, f64)> = Vec::new();
                for p in procs {
                    if !seen.insert(p.pid) {
                        continue;
                    }
                    if let UsedGpuMemory::Used(bytes) = p.used_gpu_memory {
                        let name = sys
                            .process(sysinfo::Pid::from_u32(p.pid))
                            .map(|pr| pr.name().to_string_lossy().to_string())
                            .unwrap_or_else(|| format!("pid {}", p.pid));
                        by_vram.push((name, bytes as f64));
                    }
                }
                if let Some((name, bytes)) = top_of(&by_vram)
                    && *bytes > 0.0
                {
                    batch.push(SensorSample::text("proc.gpu.top.name", ts, name.clone()));
                    batch.push(SensorSample::scalar("proc.gpu.top.bytes", ts, *bytes));
                }
            }
        }

        if want_perf {
            let _t = timings.start("sensors.perf");
            batch.extend(perf_info_samples(ts));
        }
        if want_cpufreq {
            let _t = timings.start("sensors.cpufreq");
            batch.extend(cpu_freq_samples(ts, logical_cores));
        }
        if want_netlink {
            let _t = timings.start("sensors.netlink");
            batch.extend(net_link_samples(ts));
        }
        if want_conns {
            let _t = timings.start("sensors.netconn");
            batch.extend(crate::netconn::connection_samples(ts));
        }
        if want_wifi {
            let _t = timings.start("sensors.wifi");
            batch.extend(crate::wifi::wifi_samples(ts));
        }
        if want_recyclebin {
            let _t = timings.start("sensors.recyclebin");
            batch.extend(crate::recyclebin::recyclebin_samples(ts));
        }
        // Battery is cheap + presence-gated (empty on desktops), like host.idle — always-on.
        batch.extend(battery_samples(ts));
        batch.extend(battery_power_samples(ts));

        if let Err(err) = app.emit(TELEMETRY_EVENT, &batch) {
            log::error("sensors", "failed to emit telemetry")
                .field("error", err)
                .emit();
        }

        // Mirror the latest values to the MCP live-state snapshot (~every 3s — cheap, small file).
        for s in &batch {
            latest.insert(s.sensor.clone(), s.value.clone());
        }
        snap_tick = snap_tick.wrapping_add(1);
        if snap_tick.is_multiple_of(3) {
            write_state_snapshot(&app, &latest);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_sample_serializes_to_bridge_contract() {
        let sample = SensorSample::scalar("cpu.total", 1_700_000_000_000, 12.5);
        let json = serde_json::to_value(&sample).unwrap();

        assert_eq!(json["sensor"], "cpu.total");
        assert_eq!(json["ts_ms"], 1_700_000_000_000u64);
        assert_eq!(json["value"]["kind"], "scalar");
        assert_eq!(json["value"]["value"], 12.5);
    }

    #[test]
    fn text_sample_serializes_to_bridge_contract() {
        let sample = SensorSample::text("cpu.brand", 1_700_000_000_000, "AMD Ryzen 9 7950X");
        let json = serde_json::to_value(&sample).unwrap();

        assert_eq!(json["sensor"], "cpu.brand");
        assert_eq!(json["value"]["kind"], "text");
        assert_eq!(json["value"]["value"], "AMD Ryzen 9 7950X");
    }

    #[test]
    fn percent_handles_zero_total() {
        assert_eq!(percent(0, 0), 0.0);
        assert_eq!(percent(5, 0), 0.0);
    }

    #[test]
    fn percent_computes_ratio() {
        assert_eq!(percent(50, 200), 25.0);
        assert_eq!(percent(8, 16), 50.0);
    }

    #[test]
    fn rate_per_sec_scales_to_one_second() {
        assert_eq!(rate_per_sec(1000, 1000), 1000.0);
        assert_eq!(rate_per_sec(2000, 500), 4000.0);
        assert_eq!(rate_per_sec(100, 0), 0.0);
    }

    #[test]
    fn core_sensor_id_is_zero_indexed() {
        assert_eq!(core_sensor_id(0), "cpu.core.0");
        assert_eq!(core_sensor_id(7), "cpu.core.7");
    }

    #[test]
    fn disk_letter_lowercases_the_drive_letter() {
        assert_eq!(disk_letter(Path::new("C:\\")).as_deref(), Some("c"));
        assert_eq!(disk_letter(Path::new("D:\\")).as_deref(), Some("d"));
        // A mount point that doesn't start with a letter has no slug.
        assert_eq!(disk_letter(Path::new("\\\\?\\Volume{abc}")), None);
        assert_eq!(disk_letter(Path::new("/mnt/data")), None);
    }

    #[test]
    fn battery_helpers_decode_win32_sentinels() {
        // Presence: 128 = no battery (desktop), 255 = unknown — both absent.
        assert!(!battery_present(128));
        assert!(!battery_present(255));
        assert!(battery_present(1)); // high
        assert!(battery_present(8)); // charging

        // Percent: 255 is the unknown sentinel.
        assert_eq!(battery_percent(80), Some(80.0));
        assert_eq!(battery_percent(255), None);

        // Seconds remaining: u32::MAX is unknown / on AC.
        assert_eq!(battery_seconds(3600), Some(3600));
        assert_eq!(battery_seconds(u32::MAX), None);

        // State: charging bit wins, then AC line status.
        assert_eq!(battery_state(1, 8), "charging");
        assert_eq!(battery_state(1, 1), "ac");
        assert_eq!(battery_state(0, 1), "discharging");
        assert_eq!(battery_state(255, 1), "unknown");
    }

    #[test]
    fn bytes_from_pages_multiplies_by_page_size() {
        assert_eq!(bytes_from_pages(0, 4096), 0.0);
        assert_eq!(bytes_from_pages(10, 4096), 40960.0);
        // Saturating: a pathological product can't wrap to a small value.
        assert_eq!(bytes_from_pages(usize::MAX, usize::MAX), u64::MAX as f64);
    }

    #[test]
    fn idle_seconds_from_handles_the_tick_wrap() {
        // now 12_000 ms, last input 9_500 ms → 2.5 s → 2 s (integer seconds).
        assert_eq!(idle_seconds_from(12_000, 9_500), 2);
        // GetTickCount (low 32 bits) wrapped since the last input: wrapping_sub recovers the delta.
        let last = u32::MAX - 500; // 500 ms before the wrap
        assert_eq!(idle_seconds_from(1_500, last), 2); // 500 + 1_500 = 2_000 ms → 2 s
    }

    #[test]
    fn busy_pct_is_active_fraction_clamped() {
        // 0.25s idle out of a 1s window → 75% busy.
        assert_eq!(busy_pct(2_500_000, 10_000_000), 75.0);
        // Idle exceeding the window (counter skew) clamps to 0, never negative.
        assert_eq!(busy_pct(12_000_000, 10_000_000), 0.0);
        // No elapsed time → 0 (avoids div-by-zero).
        assert_eq!(busy_pct(0, 0), 0.0);
    }

    #[test]
    fn disk_io_samples_derive_rates_and_busy() {
        // query delta = 10_000_000 ×100ns = 1.0s; idle delta = 4_000_000 ×100ns = 0.4s.
        let prev = DiskIo { idle: 0, query: 0, read: 0, written: 0 };
        let cur = DiskIo { idle: 4_000_000, query: 10_000_000, read: 2048, written: 1024 };
        let s = disk_io_samples_for("c", 1, prev, cur);
        assert_eq!(s[0].sensor, "disk.c.busy.pct");
        assert_eq!(s[1].sensor, "disk.c.read");
        assert_eq!(s[2].sensor, "disk.c.write");
        let val = |v: &SensorValue| match v {
            SensorValue::Scalar(x) => *x,
            _ => f64::NAN,
        };
        assert_eq!(val(&s[0].value), 60.0); // 1 - 0.4 = 0.6 → 60%
        assert_eq!(val(&s[1].value), 2048.0); // 2048 B over the 1.0s query delta
        assert_eq!(val(&s[2].value), 1024.0);

        // After a demand-gate gap the query delta widens with real time, so the byte delta is spread
        // over the true elapsed and the rate stays sane — never an N× spike. 5120 B over a 5s gap.
        let gap_prev = DiskIo { idle: 0, query: 0, read: 0, written: 0 };
        let gap_cur = DiskIo { idle: 0, query: 50_000_000, read: 5120, written: 0 };
        let g = disk_io_samples_for("c", 1, gap_prev, gap_cur);
        assert_eq!(val(&g[1].value), 1024.0); // 5120 B / 5s, not 5120 B/s
    }

    #[test]
    fn utf16_to_string_stops_at_nul() {
        let buf: Vec<u16> = "Ethernet\0\0\0".encode_utf16().collect();
        assert_eq!(utf16_to_string(&buf), "Ethernet");
        assert_eq!(utf16_to_string(&[]), "");
    }

    #[test]
    fn disk_io_and_netlink_gate_predicates() {
        assert!(is_disk_io_id("disk.c.busy.pct"));
        assert!(is_disk_io_id("disk.c.read"));
        assert!(is_disk_io_id("disk.d.write"));
        // Capacity ids are NOT I/O — they don't trigger the volume-handle/IOCTL path.
        assert!(!is_disk_io_id("disk.c.used.pct"));
        assert!(!is_disk_io_id("disk.c.total"));

        assert!(is_netlink_id("net.linkspeed.rx"));
        assert!(is_netlink_id("net.adapter"));
        assert!(is_netlink_id("net.state"));
        assert!(!is_netlink_id("net.down")); // aggregate throughput, always-on
    }

    #[test]
    fn perf_and_cpufreq_gate_predicates() {
        assert!(is_perf_id("mem.commit.used"));
        assert!(is_perf_id("mem.commit.limit"));
        assert!(is_perf_id("mem.cached"));
        assert!(is_perf_id("mem.kernel.nonpaged"));
        assert!(is_perf_id("host.handles"));
        assert!(is_perf_id("host.threads"));
        assert!(!is_perf_id("mem.used"));
        assert!(!is_perf_id("host.procs"));

        assert!(is_cpufreq_id("cpu.freq.current"));
        assert!(is_cpufreq_id("cpu.freq.max"));
        assert!(is_cpufreq_id("cpu.core.5.freq"));
        assert!(!is_cpufreq_id("cpu.freq")); // the sysinfo base-clock sensor, gated separately
        assert!(!is_cpufreq_id("cpu.core.5")); // per-core usage, not frequency
    }

    /// Build an `ActiveSensors` map from `(label, &[ids])` pairs.
    fn active(entries: &[(&str, &[&str])]) -> HashMap<String, HashSet<String>> {
        entries
            .iter()
            .map(|(label, ids)| {
                (label.to_string(), ids.iter().map(|s| s.to_string()).collect())
            })
            .collect()
    }

    #[test]
    fn gpu_wanted_defaults_on_when_nobody_reported() {
        // Empty map: no window has reported yet → sample everything for safety.
        assert!(gpu_wanted(&HashMap::new()));
        // A window that reported an empty set is treated like "not reported yet".
        assert!(gpu_wanted(&active(&[("main", &[])])));
    }

    #[test]
    fn gpu_wanted_false_when_only_cheap_sensors() {
        assert!(!gpu_wanted(&active(&[("main", &["cpu.total"])])));
        assert!(!gpu_wanted(&active(&[
            ("main", &["cpu.total", "mem.used"]),
            ("overlay-1", &["net.down"])
        ])));
    }

    #[test]
    fn gpu_wanted_true_for_any_gpu_prefixed_id() {
        // The prefix gate covers both the original and the new gpu.* ids.
        assert!(gpu_wanted(&active(&[("main", &["gpu.util"])])));
        assert!(gpu_wanted(&active(&[("main", &["gpu.vram.total"])])));
        assert!(gpu_wanted(&active(&[("main", &["gpu.clock.core"])])));
        assert!(gpu_wanted(&active(&[("main", &["gpu.power"])])));
    }

    #[test]
    fn gpu_wanted_true_for_star_sentinel() {
        assert!(gpu_wanted(&active(&[("studio", &["*"])])));
    }

    #[test]
    fn any_wanted_gates_disks_procs_and_freq() {
        let disks = active(&[("main", &["cpu.total", "disk.c.free"])]);
        assert!(any_wanted(&disks, |id| id.starts_with("disk.")));
        assert!(!any_wanted(&disks, |id| id == "host.procs"));

        let procs = active(&[("main", &["host.procs"])]);
        assert!(any_wanted(&procs, |id| id == "host.procs"));
        assert!(!any_wanted(&procs, |id| id.starts_with("disk.")));

        // The wildcard turns every gate on.
        let star = active(&[("studio", &["*"])]);
        assert!(any_wanted(&star, |id| id == "cpu.freq"));
        assert!(any_wanted(&star, |id| id.starts_with("disk.")));

        // proc.* gating is independent of host.procs.
        let proctop = active(&[("main", &["proc.cpu.top.name"])]);
        assert!(any_wanted(&proctop, |id| id.starts_with("proc.")));
        assert!(!any_wanted(&proctop, |id| id == "host.procs"));
    }

    #[test]
    fn flatten_latest_keeps_scalar_and_text_drops_others() {
        let mut latest: HashMap<String, SensorValue> = HashMap::new();
        latest.insert("cpu.total".into(), SensorValue::Scalar(42.0));
        latest.insert("net.adapter".into(), SensorValue::Text("Ethernet".into()));
        latest.insert("cpu.series".into(), SensorValue::Series(vec![1.0, 2.0]));
        let flat = flatten_latest(&latest);
        assert_eq!(flat.get("cpu.total"), Some(&serde_json::json!(42.0)));
        assert_eq!(flat.get("net.adapter"), Some(&serde_json::json!("Ethernet")));
        assert!(!flat.contains_key("cpu.series")); // Series dropped
    }

    #[test]
    fn proc_watch_helpers_parse_and_match() {
        // Name extraction tolerates dots in the process name + every suffix.
        assert_eq!(proc_watch_name_of("proc.watch.chrome.exe.running"), Some("chrome.exe"));
        assert_eq!(proc_watch_name_of("proc.watch.obs64.cpu"), Some("obs64"));
        assert_eq!(proc_watch_name_of("proc.watch.steam.mem"), Some("steam"));
        assert_eq!(proc_watch_name_of("proc.watch..running"), None);
        assert_eq!(proc_watch_name_of("proc.cpu.top.name"), None);

        let a = active(&[
            ("main", &["proc.watch.chrome.exe.running", "proc.watch.chrome.exe.cpu"]),
            ("overlay-1", &["proc.watch.Spotify.exe.running", "cpu.total"]),
        ]);
        assert_eq!(proc_watch_names(&a), vec!["Spotify.exe", "chrome.exe"]);

        // Matching is case-insensitive + ".exe"-tolerant on either side, but exact on the base name.
        assert!(name_matches("chrome.exe", "chrome"));
        assert!(name_matches("chrome.exe", "Chrome.exe"));
        assert!(name_matches("Discord.exe", "discord.exe"));
        assert!(!name_matches("chromedriver.exe", "chrome"));
        assert!(!name_matches("notepad.exe", "wordpad"));
    }

    #[test]
    fn top_of_picks_the_max_and_handles_empty() {
        let items = vec![
            ("a.exe".to_string(), 3.0),
            ("b.exe".to_string(), 9.5),
            ("c.exe".to_string(), 1.0),
        ];
        assert_eq!(top_of(&items).map(|(n, _)| n.as_str()), Some("b.exe"));
        assert!(top_of(&[]).is_none());
    }
}
