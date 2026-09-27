//! Native overlay snapshots for the case where a Tauri window exists but its widgets disappear.
//! These run in the host process before Studio/refit can change the evidence, even if an overlay's
//! WebView2 renderer has stopped answering the JS diagnostics bridge.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::Manager;

/// Repeated tray clicks can request many after-action snapshots within 1.5 seconds. Keep only
/// one delayed task alive at a time; every click still gets its immediate before-action snapshot.
static AFTER_PENDING: AtomicBool = AtomicBool::new(false);
static SNAPSHOT_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct BoxPx {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

fn intersects(a: BoxPx, b: BoxPx) -> bool {
    a.w > 0
        && a.h > 0
        && b.w > 0
        && b.h > 0
        && a.x < b.x.saturating_add(b.w)
        && b.x < a.x.saturating_add(a.w)
        && a.y < b.y.saturating_add(b.h)
        && b.y < a.y.saturating_add(a.h)
}

/// Log one line per app window and a monitor baseline. Call before a recovery action so the
/// action itself cannot erase the state we need to diagnose. This is intentionally best-effort.
pub fn log_snapshot(app: &tauri::AppHandle, reason: &'static str) {
    #[cfg(target_os = "windows")]
    log_snapshot_windows(app, reason);
    #[cfg(not(target_os = "windows"))]
    let _ = (app, reason);
}

/// Capture the settled native state after Studio/refit has had time to act. The snapshot itself
/// returns to the main thread because Tauri's monitor/window getters are safest there.
pub fn log_after(app: &tauri::AppHandle, reason: &'static str) {
    if AFTER_PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        let handle = app.clone();
        if app
            .run_on_main_thread(move || {
                log_snapshot(&handle, reason);
                AFTER_PENDING.store(false, Ordering::SeqCst);
            })
            .is_err()
        {
            // If shutdown prevented dispatch, do not leave the guard permanently claimed.
            AFTER_PENDING.store(false, Ordering::SeqCst);
        }
    });
}

#[cfg(target_os = "windows")]
fn log_snapshot_windows(app: &tauri::AppHandle, reason: &'static str) {
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{
        DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GWL_EXSTYLE, GWL_STYLE, GetForegroundWindow, GetLayeredWindowAttributes,
        GetWindowLongW, GetWindowRect, IsIconic, IsWindowVisible, LAYERED_WINDOW_ATTRIBUTES_FLAGS,
    };
    use windows::core::BOOL;

    extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: lparam points to this call's Vec for the synchronous EnumWindows traversal.
        let windows = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
        windows.push(hwnd);
        true.into()
    }

    let available = app.available_monitors().unwrap_or_default();
    let monitors: Vec<BoxPx> = available
        .iter()
        .map(|m| BoxPx {
            x: m.position().x,
            y: m.position().y,
            w: m.size().width as i32,
            h: m.size().height as i32,
        })
        .collect();
    let mut z_order = Vec::<HWND>::new();
    let z_order_ok =
        unsafe { EnumWindows(Some(collect), LPARAM(&mut z_order as *mut _ as isize)) }.is_ok();

    let windows = app.webview_windows();
    let snapshot_id = SNAPSHOT_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    crate::log::info("overlay_diag", "native snapshot")
        .field("snapshot_id", snapshot_id)
        .field("pid", std::process::id())
        .field("reason", reason)
        .field("monitor_count", monitors.len())
        .field("window_count", windows.len())
        .emit();
    for (index, (monitor, box_px)) in available.iter().zip(&monitors).enumerate() {
        crate::log::info("overlay_diag", "monitor geometry")
            .field("snapshot_id", snapshot_id)
            .field("pid", std::process::id())
            .field("reason", reason)
            .field("index", index)
            .field("name", monitor.name().map(String::as_str).unwrap_or(""))
            .field("x", box_px.x)
            .field("y", box_px.y)
            .field("width", box_px.w)
            .field("height", box_px.h)
            .emit();
    }
    for (label, window) in windows {
        if label != "main" && !label.starts_with("overlay-") {
            continue;
        }
        let Ok(raw) = window.hwnd() else {
            crate::log::warn("overlay_diag", "window has no HWND")
                .field("snapshot_id", snapshot_id)
                .field("pid", std::process::id())
                .field("reason", reason)
                .field("window", label)
                .emit();
            continue;
        };
        let hwnd = HWND(raw.0 as _);
        let mut rect = RECT::default();
        let rect_ok = unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok();
        let box_px = BoxPx {
            x: rect.left,
            y: rect.top,
            w: rect.right - rect.left,
            h: rect.bottom - rect.top,
        };
        let mut frame = RECT::default();
        let frame_ok = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut frame as *mut _ as *mut c_void,
                size_of::<RECT>() as u32,
            )
        }
        .is_ok();
        let mut cloaked = 0u32;
        let cloak_ok = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut _ as *mut c_void,
                size_of::<u32>() as u32,
            )
        }
        .is_ok();
        let z_rank = if z_order_ok {
            z_order.iter().position(|candidate| *candidate == hwnd)
        } else {
            None
        };
        let overlapping_above = z_rank.map(|rank| {
            z_order[..rank]
                .iter()
                .filter(|candidate| unsafe { IsWindowVisible(**candidate) }.as_bool())
                .filter(|candidate| {
                    let mut other = RECT::default();
                    unsafe { GetWindowRect(**candidate, &mut other) }.is_ok()
                        && intersects(
                            box_px,
                            BoxPx {
                                x: other.left,
                                y: other.top,
                                w: other.right - other.left,
                                h: other.bottom - other.top,
                            },
                        )
                })
                .count()
        });
        let mut alpha = 0u8;
        let mut alpha_flags = LAYERED_WINDOW_ATTRIBUTES_FLAGS::default();
        let alpha_ok = unsafe {
            GetLayeredWindowAttributes(hwnd, None, Some(&mut alpha), Some(&mut alpha_flags))
        }
        .is_ok();
        // Exactly 16 fields: log.rs bounds records at 16, so do not add one without updating
        // that cap (or splitting this event). Presentation is a separate record for this reason.
        crate::log::info("overlay_diag", "window geometry")
            .field("snapshot_id", snapshot_id)
            .field("pid", std::process::id())
            .field("reason", reason)
            .field("window", &label)
            .field("hwnd", format!("{:?}", hwnd))
            .field("rect_ok", rect_ok)
            .field("x", box_px.x)
            .field("y", box_px.y)
            .field("width", box_px.w)
            .field("height", box_px.h)
            .field("frame_ok", frame_ok)
            .field("frame_x", frame.left)
            .field("frame_y", frame.top)
            .field("frame_width", frame.right - frame.left)
            .field("frame_height", frame.bottom - frame.top)
            .field(
                "on_monitor",
                rect_ok && monitors.iter().any(|m| intersects(box_px, *m)),
            )
            .emit();
        crate::log::info("overlay_diag", "window presentation")
            .field("snapshot_id", snapshot_id)
            .field("pid", std::process::id())
            .field("reason", reason)
            .field("window", label)
            .field("hwnd", format!("{:?}", hwnd))
            .field("visible", unsafe { IsWindowVisible(hwnd) }.as_bool())
            .field("minimized", unsafe { IsIconic(hwnd) }.as_bool())
            .field(
                "cloaked",
                if cloak_ok {
                    cloaked.to_string()
                } else {
                    "unavailable".to_string()
                },
            )
            .field(
                "z_rank",
                z_rank.map_or("unavailable".to_string(), |n| n.to_string()),
            )
            .field(
                "overlapping_above",
                overlapping_above.map_or("unavailable".to_string(), |n| n.to_string()),
            )
            .field("foreground", unsafe { GetForegroundWindow() } == hwnd)
            .field(
                "alpha",
                if alpha_ok {
                    alpha.to_string()
                } else {
                    "unavailable".to_string()
                },
            )
            .field(
                "alpha_flags",
                if alpha_ok {
                    format!("0x{:x}", alpha_flags.0)
                } else {
                    "unavailable".to_string()
                },
            )
            .field(
                "style",
                format!("0x{:08x}", unsafe { GetWindowLongW(hwnd, GWL_STYLE) }
                    as u32),
            )
            .field(
                "ex_style",
                format!("0x{:08x}", unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) }
                    as u32),
            )
            .emit();
    }
}

#[cfg(test)]
mod tests {
    use super::{BoxPx, intersects};

    #[test]
    fn detects_a_window_moved_completely_off_connected_monitors() {
        let monitor = BoxPx {
            x: 652,
            y: 2160,
            w: 2560,
            h: 720,
        };
        assert!(intersects(
            BoxPx {
                x: 644,
                y: 2152,
                w: 2576,
                h: 736
            },
            monitor
        ));
        assert!(!intersects(
            BoxPx {
                x: -27,
                y: 1432,
                w: 600,
                h: 400
            },
            monitor
        ));
        assert!(!intersects(
            BoxPx {
                x: 3212,
                y: 2160,
                w: 300,
                h: 300
            },
            monitor
        ));
    }
}
