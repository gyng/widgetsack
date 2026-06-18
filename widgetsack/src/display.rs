//! Friendly monitor names (Windows CCD API) — the anti-corruption edge.
//!
//! Tauri's `Monitor.name` is only the GDI device name (`\\.\DISPLAY1`); the human-readable model name
//! ("Dell U2720Q") lives in the EDID and is reachable only via the Win32 Connecting-and-Configuring-
//! Displays API. The unsafe enumeration is quarantined here; the pure UTF-16 → String seam
//! (`wide_to_string`) holds the only real logic and is unit-tested on any OS. Everything else in the app
//! deals in `DisplayName { gdi, friendly }` pairs (serialized across the bridge), keyed on the same GDI
//! device name the overlays/studio already use, so the frontend can append the friendly name to its
//! monitor-switcher labels with a safe fallback when it's blank.

use std::collections::HashMap;

use serde::Serialize;

/// One active display: its GDI device name (`\\.\DISPLAY1`) and the friendly/EDID name. `friendly` can
/// be empty (virtual / RDP / nameless panels, or an API miss) — the caller falls back to `gdi` then.
#[derive(Debug, Clone, Serialize)]
pub struct DisplayName {
    pub gdi: String,
    pub friendly: String,
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
/// gathered so far (or none), never an error — this only enriches a label.
#[tauri::command]
pub fn list_display_names() -> Vec<DisplayName> {
    enumerate()
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
            let friendly = if DisplayConfigGetDeviceInfo(&mut tgt.header) == 0 {
                wide_to_string(&tgt.monitorFriendlyDeviceName)
            } else {
                String::new()
            };

            out.push(DisplayName { gdi, friendly });
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
}
