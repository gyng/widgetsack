//! Recycle Bin contents — item count + total size, for a "needs emptying?" glance. One
//! `SHQueryRecycleBin` call summed across all drives per tick, demand-gated on `recyclebin.*` so
//! nothing runs unless the widget is mounted. Emits `recyclebin.items` (count) + `recyclebin.bytes`.

use crate::sensors::SensorSample;

/// Build the `recyclebin.*` samples from a raw (items, bytes) reading. Negative sentinels (an
/// uninitialised/empty bin can report -1) clamp to 0. Pure seam — unit-tested.
pub fn recyclebin_samples_from(items: i64, bytes: i64, ts: u64) -> Vec<SensorSample> {
    vec![
        SensorSample::scalar("recyclebin.items", ts, items.max(0) as f64),
        SensorSample::scalar("recyclebin.bytes", ts, bytes.max(0) as f64),
    ]
}

/// Query the Recycle Bin across all drives (null root path). `None` on failure. The shell caches this,
/// so the per-tick cost is small.
#[cfg(target_os = "windows")]
fn query() -> Option<(i64, i64)> {
    use windows::Win32::UI::Shell::{SHQUERYRBINFO, SHQueryRecycleBinW};
    use windows::core::PCWSTR;

    let mut info = SHQUERYRBINFO {
        cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: a null root path sums across all drives; `info` is a valid owned struct with cbSize set.
    unsafe { SHQueryRecycleBinW(PCWSTR::null(), &mut info) }.ok()?;
    Some((info.i64NumItems, info.i64Size))
}

/// Sample the Recycle Bin (Windows). Empty off-Windows / on failure.
#[cfg(target_os = "windows")]
pub fn recyclebin_samples(ts: u64) -> Vec<SensorSample> {
    match query() {
        Some((items, bytes)) => recyclebin_samples_from(items, bytes, ts),
        None => Vec::new(),
    }
}

#[cfg(not(target_os = "windows"))]
pub fn recyclebin_samples(_ts: u64) -> Vec<SensorSample> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_carry_items_and_bytes_clamped() {
        let s = recyclebin_samples_from(3, 4096, 7);
        let val = |id: &str| {
            serde_json::to_value(s.iter().find(|x| x.sensor == id).unwrap()).unwrap()["value"]["value"]
                .clone()
        };
        assert_eq!(val("recyclebin.items"), 3.0);
        assert_eq!(val("recyclebin.bytes"), 4096.0);

        // The empty-bin -1 sentinel clamps to 0 rather than emitting a negative.
        let empty = recyclebin_samples_from(-1, -1, 0);
        let v0 = |id: &str| {
            serde_json::to_value(empty.iter().find(|x| x.sensor == id).unwrap()).unwrap()["value"]
                ["value"]
                .clone()
        };
        assert_eq!(v0("recyclebin.items"), 0.0);
        assert_eq!(v0("recyclebin.bytes"), 0.0);
    }
}
