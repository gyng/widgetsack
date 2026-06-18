//! DDC/CI monitor input-source switcher — the anti-corruption edge for the Monitor Switch widget.
//!
//! Switching a monitor's active input (HDMI ↔ DisplayPort ↔ …) is MCCS **VCP feature 0x60**
//! ("Input Select") sent over the DDC/CI I²C side-channel of the video cable, via the Win32 dxva2
//! Physical Monitor API. As with `display.rs`/`listener.rs`, the `unsafe` Win32 calls are quarantined
//! here; everything the rest of the app sees is `widgetsack`'s own `MonitorInputs` (serialized across
//! the bridge) keyed on the same GDI device name (`\\.\DISPLAYn`) the overlays/studio already use.
//!
//! The only real logic — parsing the monitor's capabilities string for its supported 0x60 values — is
//! the pure, cross-platform, unit-tested seam (`parse_vcp60_capabilities`).
//!
//! Caveats baked into the design:
//! - **Blocking + slow.** DDC reads take 100–300 ms and can hang on a flaky monitor, so the commands
//!   run on a `spawn_blocking` thread (never the main/UI thread) and only DDC-query the ONE requested
//!   `target` monitor (the others return their OS display mode only — that's cheap).
//! - **Vendor-specific values.** 0x60 codes are nominally standardised (0x0F DP, 0x11 HDMI1, …) but
//!   widely deviate, so we always parse the monitor's own capability list rather than assume.
//!
//! Bridge contract: `MonitorInputs` mirrors `MonitorInputs` in `client/src/lib/ddc/monitors.ts`;
//! the command names (`list_monitor_inputs`, `set_monitor_input`) must match the frontend.

use serde::Serialize;

/// One monitor's input-switching state for the Monitor Switch widget. Mirrors `MonitorInputs` in
/// `client/src/lib/ddc/monitors.ts`. Keyed by `gdi` (`\\.\DISPLAYn`). `current_input` / `supported`
/// are DDC/CI (VCP 0x60) and are only filled for the queried `target` (DDC reads are slow); other
/// monitors report `None` / empty. `width` / `height` / `refresh_hz` are the OS's current display mode
/// (cheap, always filled — 0 if unknown). `friendly` is the EDID model name (may be empty).
#[derive(Debug, Clone, Serialize)]
pub struct MonitorInputs {
    pub gdi: String,
    pub friendly: String,
    pub primary: bool,
    pub current_input: Option<u32>,
    pub supported: Vec<u32>,
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
}

/// MCCS VCP feature code for "Input Select" — the one code this widget reads, writes, and parses.
const VCP_INPUT_SELECT: u8 = 0x60;

// --- Pure seam (unit-tested, no I/O, cross-platform) -------------------------------------------

/// Parse a DDC/CI capabilities string for the supported VCP 0x60 (Input Select) values. A capabilities
/// string looks like `(prot(monitor)type(lcd)…vcp(02 04 … 60(0F 11 12) AC)…)`; we locate the top-level
/// `vcp(...)` block, then the `60(...)` group inside it, and read its space-separated hex bytes. Pure:
/// returns `[]` when there's no `vcp` block or no `60(...)` group. Robust to a `0x60` byte appearing as
/// a *value* of some other code (e.g. `14(60 …)`) — only a top-level `60` code is matched.
pub fn parse_vcp60_capabilities(caps: &str) -> Vec<u32> {
    let vcp = match vcp_block(caps) {
        Some(v) => v,
        None => return Vec::new(),
    };
    match value_group(&vcp, VCP_INPUT_SELECT) {
        Some(list) => parse_hex_list(&list),
        None => Vec::new(),
    }
}

/// The inner text of the top-level `vcp(...)` group (case-insensitive tag), tracking nested parens to
/// find the matching close. Capability strings are ASCII per the MCCS spec, so byte indices are fine.
fn vcp_block(caps: &str) -> Option<String> {
    let lower = caps.to_ascii_lowercase();
    let tag = lower.find("vcp(")?;
    let b = caps.as_bytes();
    let mut i = tag + 4; // first char after "vcp("
    let mut depth = 1usize;
    let mut out = String::new();
    while i < b.len() {
        let c = b[i] as char;
        match c {
            '(' => {
                depth += 1;
                out.push(c);
            }
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(out);
                }
                out.push(c);
            }
            _ => out.push(c),
        }
        i += 1;
    }
    None
}

/// Within a vcp block's inner text, return `code`'s parenthesised value list, e.g. for 0x60 in
/// `… 60(01 03 11 12) …` returns `"01 03 11 12"`. Reads top-level hex tokens; a token followed by a
/// `(...)` group carries a value list (whose contents are skipped as code candidates). `None` if the
/// code is absent or has no value group.
fn value_group(vcp: &str, code: u8) -> Option<String> {
    let b = vcp.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        if (b[i] as char).is_ascii_whitespace() {
            i += 1;
            continue;
        }
        // Read a hex token (a candidate VCP code).
        let start = i;
        while i < b.len() && (b[i] as char).is_ascii_hexdigit() {
            i += 1;
        }
        if i == start {
            // Not hex (some separator) — skip one char and retry.
            i += 1;
            continue;
        }
        let this = u8::from_str_radix(&vcp[start..i], 16).ok();
        // Optional parenthesised value group immediately after the code.
        if i < b.len() && b[i] as char == '(' {
            i += 1; // past '('
            let vstart = i;
            let mut depth = 1usize;
            while i < b.len() && depth > 0 {
                match b[i] as char {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            let inner = &vcp[vstart..i];
            if i < b.len() {
                i += 1; // past ')'
            }
            if this == Some(code) {
                return Some(inner.to_string());
            }
        }
    }
    None
}

/// Split a whitespace-separated list of hex byte values (`"01 03 11 12"`) into numbers; junk tokens
/// are dropped. Pure.
fn parse_hex_list(s: &str) -> Vec<u32> {
    s.split_whitespace()
        .filter_map(|t| u32::from_str_radix(t, 16).ok())
        .collect()
}

// --- Tauri commands ----------------------------------------------------------------------------

/// All monitors with their current/supported DDC input source (VCP 0x60) and current display mode.
/// DDC reads are slow and can hang on a flaky monitor, so they run on a blocking thread and only for
/// the requested `target` (a GDI device name; the primary monitor when blank/None) — every other
/// monitor returns its display mode (resolution + refresh) only. Empty off-Windows.
#[tauri::command]
pub async fn list_monitor_inputs(target: Option<String>) -> Vec<MonitorInputs> {
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(move || enumerate_blocking(target))
            .await
            .unwrap_or_default()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = target;
        Vec::new()
    }
}

/// Switch `target` (a GDI device name, `\\.\DISPLAYn`) to VCP 0x60 input `value`. Errs if the monitor
/// can't be found or rejects the switch (DDC/CI disabled in the OSD, or an unsupported value). Runs on
/// a blocking thread. Windows-only.
#[tauri::command]
pub async fn set_monitor_input(target: String, value: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(move || set_blocking(target, value))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (target, value);
        Err("switching monitor input is only supported on Windows".into())
    }
}

// --- Windows implementation (the unsafe Win32 edge) --------------------------------------------

/// Collect every monitor's `HMONITOR` via `EnumDisplayMonitors`. The handles are only ever used on the
/// thread that gathered them (inside `spawn_blocking`), so `HMONITOR`'s non-`Send` raw pointer is fine.
#[cfg(target_os = "windows")]
fn collect_hmonitors() -> Vec<windows::Win32::Graphics::Gdi::HMONITOR> {
    use windows::Win32::Foundation::{LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR};

    unsafe extern "system" fn cb(
        h: HMONITOR,
        _dc: HDC,
        _rc: *mut RECT,
        data: LPARAM,
    ) -> windows::core::BOOL {
        // SAFETY: `data` carries the `&mut Vec<HMONITOR>` we hand to EnumDisplayMonitors below; it
        // outlives the (synchronous) enumeration.
        unsafe {
            let v = &mut *(data.0 as *mut Vec<HMONITOR>);
            v.push(h);
        }
        windows::core::BOOL(1) // keep enumerating
    }

    let mut handles: Vec<HMONITOR> = Vec::new();
    let ptr = &mut handles as *mut Vec<HMONITOR>;
    // SAFETY: standard EnumDisplayMonitors callback pattern; `ptr` is valid for the call.
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(cb), LPARAM(ptr as isize));
    }
    handles
}

/// `(gdi device name, is-primary)` for an `HMONITOR`, or `None` if the info call fails / the name is
/// blank. `MONITORINFOF_PRIMARY` is the low bit of `dwFlags` (the windows-rs metadata doesn't export
/// the constant, so the bit is inlined).
#[cfg(target_os = "windows")]
fn monitor_gdi(h: windows::Win32::Graphics::Gdi::HMONITOR) -> Option<(String, bool)> {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITORINFO, MONITORINFOEXW};

    let mut mi = MONITORINFOEXW::default();
    mi.monitorInfo.cbSize = core::mem::size_of::<MONITORINFOEXW>() as u32;
    // SAFETY: `cbSize` is set to the EX size so Win32 fills `szDevice`; the pointer is to the struct
    // start (monitorInfo is its first field).
    let ok = unsafe { GetMonitorInfoW(h, &mut mi.monitorInfo as *mut MONITORINFO) };
    if !ok.as_bool() {
        return None;
    }
    let gdi = crate::display::wide_to_string(&mi.szDevice);
    if gdi.is_empty() {
        return None;
    }
    let primary = (mi.monitorInfo.dwFlags & 1) != 0; // MONITORINFOF_PRIMARY
    Some((gdi, primary))
}

/// The monitor's current display mode `(width, height, refresh_hz)` from `EnumDisplaySettingsW`,
/// keyed by GDI device name. `(0, 0, 0)` if unknown. Cheap (no DDC).
#[cfg(target_os = "windows")]
fn current_mode(gdi: &str) -> (u32, u32, u32) {
    use std::iter::once;
    use windows::Win32::Graphics::Gdi::{DEVMODEW, ENUM_CURRENT_SETTINGS, EnumDisplaySettingsW};
    use windows::core::PCWSTR;

    let wide: Vec<u16> = gdi.encode_utf16().chain(once(0)).collect();
    let mut dm = DEVMODEW {
        dmSize: core::mem::size_of::<DEVMODEW>() as u16,
        ..Default::default()
    };
    // SAFETY: `wide` is a NUL-terminated UTF-16 device name that outlives the call; `dm` is sized.
    let ok = unsafe { EnumDisplaySettingsW(PCWSTR(wide.as_ptr()), ENUM_CURRENT_SETTINGS, &mut dm) };
    if ok.as_bool() {
        (dm.dmPelsWidth, dm.dmPelsHeight, dm.dmDisplayFrequency)
    } else {
        (0, 0, 0)
    }
}

/// DDC-query one monitor: its current input (VCP 0x60) and the supported inputs parsed from its
/// capabilities string. `None` if the monitor exposes no physical-monitor handle (DDC/CI unavailable).
/// `current_input` is `None` when the 0x60 read fails; `supported` is empty when caps can't be read.
#[cfg(target_os = "windows")]
fn query_ddc(hmon: windows::Win32::Graphics::Gdi::HMONITOR) -> Option<(Option<u32>, Vec<u32>)> {
    use windows::Win32::Devices::Display::{
        CapabilitiesRequestAndCapabilitiesReply, DestroyPhysicalMonitors,
        GetCapabilitiesStringLength, GetNumberOfPhysicalMonitorsFromHMONITOR,
        GetPhysicalMonitorsFromHMONITOR, GetVCPFeatureAndVCPFeatureReply, PHYSICAL_MONITOR,
    };

    // SAFETY: dxva2 physical-monitor lifecycle — create handles, query, then always destroy them.
    unsafe {
        let mut count: u32 = 0;
        GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, &mut count).ok()?;
        if count == 0 {
            return None;
        }
        let mut monitors = vec![PHYSICAL_MONITOR::default(); count as usize];
        GetPhysicalMonitorsFromHMONITOR(hmon, &mut monitors).ok()?;
        let handle = monitors[0].hPhysicalMonitor;

        // Current input (VCP 0x60). Returns i32: nonzero = success. The reply is a 16-bit value but
        // input-select is a single byte; some monitors echo it into the high byte too (e.g. 0x0F0F for
        // DisplayPort 0x0F), so mask to the low byte to match the capability list (0x0F/0x11/0x12…).
        let mut current: u32 = 0;
        let current_input =
            if GetVCPFeatureAndVCPFeatureReply(handle, VCP_INPUT_SELECT, None, &mut current, None)
                != 0
            {
                Some(current & 0xFF)
            } else {
                None
            };

        // Supported inputs from the capabilities string (ASCII, NUL-terminated).
        let mut supported = Vec::new();
        let mut len: u32 = 0;
        if GetCapabilitiesStringLength(handle, &mut len) != 0 && len > 0 {
            let mut buf = vec![0u8; len as usize];
            if CapabilitiesRequestAndCapabilitiesReply(handle, &mut buf) != 0 {
                let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                let caps = String::from_utf8_lossy(&buf[..end]);
                supported = parse_vcp60_capabilities(&caps);
            }
        }

        let _ = DestroyPhysicalMonitors(&monitors);
        Some((current_input, supported))
    }
}

#[cfg(target_os = "windows")]
fn enumerate_blocking(target: Option<String>) -> Vec<MonitorInputs> {
    struct Base {
        h: windows::Win32::Graphics::Gdi::HMONITOR,
        gdi: String,
        primary: bool,
        width: u32,
        height: u32,
        refresh: u32,
    }

    let friendly = crate::display::friendly_map();

    // Cheap base info for every monitor (no DDC yet).
    let mut bases: Vec<Base> = Vec::new();
    for h in collect_hmonitors() {
        if let Some((gdi, primary)) = monitor_gdi(h) {
            let (width, height, refresh) = current_mode(&gdi);
            bases.push(Base {
                h,
                gdi,
                primary,
                width,
                height,
                refresh,
            });
        }
    }

    // Resolve which monitor to DDC-query: the requested GDI name, else the primary, else the first.
    let want = target.unwrap_or_default();
    let target_idx = bases
        .iter()
        .position(|b| !want.is_empty() && b.gdi == want)
        .or_else(|| bases.iter().position(|b| b.primary))
        .or_else(|| (!bases.is_empty()).then_some(0));

    bases
        .iter()
        .enumerate()
        .map(|(idx, b)| {
            let (current_input, supported) = if Some(idx) == target_idx {
                query_ddc(b.h).unwrap_or((None, Vec::new()))
            } else {
                (None, Vec::new())
            };
            MonitorInputs {
                gdi: b.gdi.clone(),
                friendly: friendly.get(&b.gdi).cloned().unwrap_or_default(),
                primary: b.primary,
                current_input,
                supported,
                width: b.width,
                height: b.height,
                refresh_hz: b.refresh,
            }
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn set_blocking(target: String, value: u32) -> Result<(), String> {
    use windows::Win32::Devices::Display::{
        DestroyPhysicalMonitors, GetNumberOfPhysicalMonitorsFromHMONITOR,
        GetPhysicalMonitorsFromHMONITOR, PHYSICAL_MONITOR, SetVCPFeature,
    };

    if target.is_empty() {
        return Err("no monitor specified".into());
    }

    // Find the HMONITOR whose GDI device name matches `target`.
    let hmon = collect_hmonitors()
        .into_iter()
        .find(|&h| {
            monitor_gdi(h)
                .map(|(gdi, _)| gdi == target)
                .unwrap_or(false)
        })
        .ok_or_else(|| format!("monitor {target} not found"))?;

    // SAFETY: dxva2 physical-monitor lifecycle — create, set VCP 0x60, always destroy.
    unsafe {
        let mut count: u32 = 0;
        GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, &mut count).map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("no physical monitor for this display (DDC/CI unavailable)".into());
        }
        let mut monitors = vec![PHYSICAL_MONITOR::default(); count as usize];
        GetPhysicalMonitorsFromHMONITOR(hmon, &mut monitors).map_err(|e| e.to_string())?;
        let rc = SetVCPFeature(monitors[0].hPhysicalMonitor, VCP_INPUT_SELECT, value);
        let _ = DestroyPhysicalMonitors(&monitors);
        if rc == 0 {
            return Err(
				"the monitor rejected the input switch (DDC/CI off in the OSD, or an unsupported value)"
					.into(),
			);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vcp60_input_list() {
        let caps = "(prot(monitor)type(lcd)model(U2720Q)cmds(01 02 03)vcp(02 04 05 10 12 60(0F 11 12) AC B6)mccs_ver(2.1))";
        assert_eq!(parse_vcp60_capabilities(caps), vec![0x0F, 0x11, 0x12]);
    }

    #[test]
    fn no_vcp60_group_is_empty() {
        let caps = "(prot(monitor)vcp(02 04 10 12))";
        assert!(parse_vcp60_capabilities(caps).is_empty());
    }

    #[test]
    fn missing_vcp_block_is_empty() {
        assert!(parse_vcp60_capabilities("garbage").is_empty());
        assert!(parse_vcp60_capabilities("").is_empty());
    }

    #[test]
    fn case_insensitive_tag_and_hex() {
        let caps = "(VCP(60(01 03 0f)))";
        assert_eq!(parse_vcp60_capabilities(caps), vec![0x01, 0x03, 0x0F]);
    }

    #[test]
    fn ignores_0x60_inside_other_value_groups() {
        // 14(60 05) is colour-preset code 0x14 carrying value 0x60 — must NOT be read as the 0x60 list.
        let caps = "(vcp(14(60 05) 60(11 12)))";
        assert_eq!(parse_vcp60_capabilities(caps), vec![0x11, 0x12]);
    }
}
