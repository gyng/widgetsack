//! Friendly monitor names (Windows CCD API) — the anti-corruption edge.
//!
//! Tauri's `Monitor.name` is only the GDI device name (`\\.\DISPLAY1`); the human-readable model name
//! ("Dell U2720Q") lives in the EDID and is reachable only via the Win32 Connecting-and-Configuring-
//! Displays API. The unsafe enumeration is quarantined here; the pure UTF-16 → String seam
//! (`wide_to_string`) holds the only real logic and is unit-tested on any OS. Everything else in the app
//! deals in `DisplayName { gdi, friendly, stable }` triples (serialized across the bridge), keyed on the
//! same GDI device name the overlays/studio already use, so the frontend can append the friendly name to
//! its monitor-switcher labels with a safe fallback when it's blank.
//!
//! `stable` is the monitor's durable identity, derived from the CCD `monitorDevicePath`
//! (`\\?\DISPLAY#<EDID hw id>#<instance>&UID<connector>#{guid}`) — the same identity Windows keys its
//! own per-monitor settings on. The GDI name is NOT stable: Windows re-numbers `\\.\DISPLAYn` when
//! displays are re-enumerated (a primary switched to another input and back, sleep/wake), and on
//! 2026-09-19 that moved a whole layout onto the wrong monitor. Layout keys use `stable` (frontend
//! monitorKey.ts), falling back to the GDI tag only where no path is available.

use std::collections::HashMap;

use serde::Serialize;

/// One active display: its GDI device name (`\\.\DISPLAY1`), the friendly/EDID name, and its stable
/// identity key (see `stable_key_from_device_path`). `friendly` / `stable` can be empty (virtual / RDP /
/// nameless panels, or an API miss) — the caller falls back to `gdi` then.
#[derive(Debug, Clone, Serialize)]
pub struct DisplayName {
    pub gdi: String,
    pub friendly: String,
    pub stable: String,
}

/// Pure seam: a monitor's stable layout key from its CCD `monitorDevicePath`, e.g.
/// `\\?\DISPLAY#CRXED00#5&22f091d4&2&UID184576#{e6f07b5f-…}` → `CRXED00-UID184576`: the EDID hardware
/// id (manufacturer + product code) plus the connector `UID` (the GPU output the monitor hangs off).
/// Deliberately drops the middle device-instance hash (the GPU's devnode), so a driver reinstall doesn't
/// orphan every layout; two identical monitors still differ by connector. Only `[A-Za-z0-9_-]` survive
/// (the key doubles as a Tauri window-label suffix). Empty when the path has no recognisable shape.
pub fn stable_key_from_device_path(path: &str) -> String {
    let trimmed = path.trim().trim_start_matches(['\\', '?', '.']);
    let mut parts = trimmed.split('#');
    let Some(class) = parts.next() else {
        return String::new();
    };
    if !class.eq_ignore_ascii_case("DISPLAY") {
        return String::new();
    }
    let (Some(hwid), Some(instance)) = (parts.next(), parts.next()) else {
        return String::new();
    };
    let hwid = sanitize_key(hwid);
    if hwid.is_empty() {
        return String::new();
    }
    // The connector id is the trailing `UID<n>` token of the instance segment; keep the whole
    // segment (sanitized) when it doesn't have that shape so the key still tells monitors apart.
    let uid = instance
        .rsplit('&')
        .next()
        .filter(|t| t.len() > 3 && t[..3].eq_ignore_ascii_case("UID"))
        .map(sanitize_key)
        .unwrap_or_else(|| sanitize_key(instance));
    if uid.is_empty() {
        hwid
    } else {
        format!("{hwid}-{uid}")
    }
}

/// Keep `[A-Za-z0-9_-]`, map every other char to `_`, and trim stray `_`.
fn sanitize_key(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

/// A fixed-size, NUL-terminated UTF-16 Win32 name buffer → a trimmed `String`. Pure seam (tested):
/// stops at the first NUL, tolerates an unterminated buffer, and trims surrounding whitespace.
/// `pub(crate)` so peers that already hold a Win32 wide buffer (e.g. ddc.rs' `MONITORINFOEXW.szDevice`)
/// decode it the same way instead of re-implementing the NUL/trim logic.
pub(crate) fn wide_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len]).trim().to_string()
}

/// All active displays with their friendly names. Best-effort: any Win32 failure yields the entries
/// gathered so far (or none), never an error — this only enriches a label. `async` so the CCD
/// queries run on a blocking-pool thread, not the main/UI thread (a sync command would): the studio
/// calls this on every display-topology change, when those APIs are slowest.
#[tauri::command]
pub async fn list_display_names() -> Vec<DisplayName> {
    tokio::task::spawn_blocking(enumerate)
        .await
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn enumerate() -> Vec<DisplayName> {
    use windows::Win32::Devices::Display::{
        DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
        DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SOURCE_DEVICE_NAME,
        DISPLAYCONFIG_TARGET_DEVICE_NAME, DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes,
        QDC_ONLY_ACTIVE_PATHS, QueryDisplayConfig,
    };
    use windows::Win32::Foundation::ERROR_SUCCESS;

    let mut out = Vec::new();
    unsafe {
        // Size the path/mode arrays for the currently-active topology, then fetch them.
        let mut n_paths: u32 = 0;
        let mut n_modes: u32 = 0;
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut n_paths, &mut n_modes)
            != ERROR_SUCCESS
        {
            return out;
        }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); n_paths as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); n_modes as usize];
        if QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut n_paths,
            paths.as_mut_ptr(),
            &mut n_modes,
            modes.as_mut_ptr(),
            None,
        ) != ERROR_SUCCESS
        {
            return out;
        }
        paths.truncate(n_paths as usize);

        for p in &paths {
            // Source → the GDI device name (\\.\DISPLAYn): the key the overlays/studio share.
            let mut src = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            src.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            src.header.size = core::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
            src.header.adapterId = p.sourceInfo.adapterId;
            src.header.id = p.sourceInfo.id;
            // DisplayConfigGetDeviceInfo returns a Win32 LONG; ERROR_SUCCESS (0) on success.
            if DisplayConfigGetDeviceInfo(&mut src.header) != 0 {
                continue;
            }
            let gdi = wide_to_string(&src.viewGdiDeviceName);
            if gdi.is_empty() {
                continue;
            }

            // Target → the friendly/EDID name. Best-effort: a failure or blank name just leaves it empty.
            let mut tgt = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
            tgt.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
            tgt.header.size = core::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32;
            tgt.header.adapterId = p.targetInfo.adapterId;
            tgt.header.id = p.targetInfo.id;
            let (friendly, stable) = if DisplayConfigGetDeviceInfo(&mut tgt.header) == 0 {
                (
                    wide_to_string(&tgt.monitorFriendlyDeviceName),
                    stable_key_from_device_path(&wide_to_string(&tgt.monitorDevicePath)),
                )
            } else {
                (String::new(), String::new())
            };

            out.push(DisplayName {
                gdi,
                friendly,
                stable,
            });
        }
    }
    out
}

#[cfg(not(target_os = "windows"))]
fn enumerate() -> Vec<DisplayName> {
    Vec::new()
}

/// GDI device name (`\\.\DISPLAYn`) → friendly/EDID name, for callers that already have a GDI name and
/// want the human label without re-running the CCD enumeration themselves (ddc.rs labels the monitor
/// switcher this way). Best-effort: empty map on failure, and blank-friendly entries are dropped so a
/// missing key cleanly means "no friendly name known" (the caller falls back to the GDI tag).
pub(crate) fn friendly_map() -> HashMap<String, String> {
    enumerate()
        .into_iter()
        .filter(|d| !d.friendly.is_empty())
        .map(|d| (d.gdi, d.friendly))
        .collect()
}

/// GDI device name → stable identity key (see `stable_key_from_device_path`), for callers that address
/// monitors by either (ddc.rs accepts a stable key OR a GDI name as the switch target). Blank keys are
/// dropped, same contract as `friendly_map`.
pub(crate) fn stable_map() -> HashMap<String, String> {
    enumerate()
        .into_iter()
        .filter(|d| !d.stable.is_empty())
        .map(|d| (d.gdi, d.stable))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wide_to_string_stops_at_first_nul() {
        // "DELL\0XX\0" → only the run before the first NUL.
        let buf: [u16; 8] = [
            b'D' as u16,
            b'E' as u16,
            b'L' as u16,
            b'L' as u16,
            0,
            b'X' as u16,
            b'X' as u16,
            0,
        ];
        assert_eq!(wide_to_string(&buf), "DELL");
    }

    #[test]
    fn wide_to_string_trims_and_tolerates_no_nul() {
        let buf: [u16; 4] = [b' ' as u16, b'L' as u16, b'G' as u16, b' ' as u16];
        assert_eq!(wide_to_string(&buf), "LG");
    }

    #[test]
    fn wide_to_string_empty_is_empty() {
        assert_eq!(wide_to_string(&[0u16]), "");
        assert_eq!(wide_to_string(&[]), "");
    }

    #[test]
    fn stable_key_is_hardware_id_plus_connector_uid() {
        // Real paths from the 2026-09-19 machine: three monitors on one GPU, told apart by UID.
        assert_eq!(
            stable_key_from_device_path(
                r"\\?\DISPLAY#CRXED00#5&22f091d4&2&UID184576#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}"
            ),
            "CRXED00-UID184576"
        );
        assert_eq!(
            stable_key_from_device_path(
                r"\\?\DISPLAY#DEL428B#5&22f091d4&2&UID184577#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}"
            ),
            "DEL428B-UID184577"
        );
    }

    #[test]
    fn stable_key_ignores_the_gpu_instance_hash_but_not_the_connector() {
        // Same monitor, GPU devnode re-created (driver reinstall) → same key.
        let a = stable_key_from_device_path(r"\\?\DISPLAY#DELD154#5&22f091d4&2&UID184579#{g}");
        let b = stable_key_from_device_path(r"\\?\DISPLAY#DELD154#5&0badf00d&0&UID184579#{g}");
        assert_eq!(a, b);
        // Same model on another connector → a different key.
        let c = stable_key_from_device_path(r"\\?\DISPLAY#DELD154#5&22f091d4&2&UID184580#{g}");
        assert_ne!(a, c);
    }

    #[test]
    fn stable_key_is_empty_or_sanitized_for_odd_paths() {
        assert_eq!(stable_key_from_device_path(""), "");
        assert_eq!(stable_key_from_device_path(r"\\?\MONITOR#X#Y"), ""); // not a DISPLAY path
        assert_eq!(stable_key_from_device_path(r"\\?\DISPLAY#ABC1234"), ""); // no instance segment
        // No `UID` token: the whole instance segment is kept, sanitized to label-safe chars.
        assert_eq!(
            stable_key_from_device_path(r"\\?\DISPLAY#ABC1234#5&1&2#{g}"),
            "ABC1234-5_1_2"
        );
    }
}
