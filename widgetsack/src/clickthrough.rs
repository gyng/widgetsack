//! Per-widget click-through. A passive overlay is whole-window click-through, but
//! Windows overlays can't pass clicks through transparent pixels — so to host the
//! occasional clickable widget we run a cursor watcher: when the cursor is over an
//! interactive widget's rect, that window's ignore-cursor-events is turned off (so
//! the click lands on the widget); otherwise it stays on (clicks pass through).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

/// A widget's hit rect in physical screen pixels (computed and sent by the frontend).
/// Also reused for the work-area query (backend → frontend), hence Serialize.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl ScreenRect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

/// Interactive hit rects per overlay window label.
#[derive(Default)]
pub struct InteractiveRects(pub Mutex<HashMap<String, Vec<ScreenRect>>>);

/// Frontend → backend: the interactive widgets' screen rects for `label`. An empty
/// list clears them (e.g. in edit mode, where the whole window is interactive).
#[tauri::command]
pub fn set_interactive_rects(
    state: tauri::State<'_, InteractiveRects>,
    label: String,
    rects: Vec<ScreenRect>,
) {
    // Recover from a poisoned lock (a prior panic while holding it) instead of panicking again —
    // the stored rects are plain data, so a poisoned guard is still safe to use.
    let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if rects.is_empty() {
        map.remove(&label);
    } else {
        map.insert(label, rects);
    }
}

/// Spawn the cursor watcher. Idles cheaply when no window has interactive rects;
/// otherwise polls ~60 Hz and toggles each window's ignore-cursor-events only on
/// transitions (entering/leaving that window's interactive rects).
pub fn run_clickthrough_watcher<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let mut ignoring: HashMap<String, bool> = HashMap::new();
        loop {
            let map = {
                let guard = app.state::<InteractiveRects>();
                // Recover a poisoned lock rather than panicking — a transient poison must not kill
                // the watcher thread (which would silently break per-widget click-through).
                let map = guard.0.lock().unwrap_or_else(|e| e.into_inner());
                map.clone()
            };
            if map.is_empty() {
                ignoring.clear();
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            std::thread::sleep(Duration::from_millis(16));

            let cursor = match app.cursor_position() {
                Ok(pos) => pos,
                Err(_) => continue,
            };
            for (label, rects) in &map {
                let over = rects.iter().any(|r| r.contains(cursor.x, cursor.y));
                let want_ignore = !over;
                if ignoring.get(label).copied() != Some(want_ignore) {
                    if let Some(win) = app.get_webview_window(label) {
                        let _ = win.set_ignore_cursor_events(want_ignore);
                    }
                    ignoring.insert(label.clone(), want_ignore);
                }
            }
        }
    });
}

/// The work area (the monitor minus the taskbar) for the calling window's monitor, in
/// PHYSICAL screen pixels. The frontend converts to local logical px for the flow root
/// bounds (Phase 5b — taskbar awareness). Windows-only; errors elsewhere.
#[tauri::command]
pub fn current_work_area(window: tauri::WebviewWindow) -> Result<ScreenRect, String> {
    work_area_for(&window)
}

#[cfg(target_os = "windows")]
fn work_area_for(window: &tauri::WebviewWindow) -> Result<ScreenRect, String> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromPoint,
    };

    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no current monitor".to_string())?;
    let pos = monitor.position();
    // A point safely inside the monitor selects the right HMONITOR without needing the HWND.
    let pt = POINT {
        x: pos.x + 1,
        y: pos.y + 1,
    };
    let hmon = unsafe { MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST) };
    let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let ok = unsafe { GetMonitorInfoW(hmon, &mut mi) };
    if !ok.as_bool() {
        return Err("GetMonitorInfoW failed".to_string());
    }
    let rc = mi.rcWork;
    Ok(ScreenRect {
        x: rc.left as f64,
        y: rc.top as f64,
        w: (rc.right - rc.left) as f64,
        h: (rc.bottom - rc.top) as f64,
    })
}

#[cfg(not(target_os = "windows"))]
fn work_area_for(_window: &tauri::WebviewWindow) -> Result<ScreenRect, String> {
    Err("work area is only available on Windows".to_string())
}

/// EXPERIMENTAL "wallpaper layer" for the calling overlay window. When `enabled`, parent it to the
/// desktop's WorkerW so it renders ON the wallpaper — behind the desktop icons and every app window,
/// surviving Show Desktop (the Wallpaper-Engine trick). When disabled, re-attach it to the
/// desktop root so it's a normal top-level overlay again. Windows-only; a no-op error elsewhere.
#[tauri::command]
pub fn set_overlay_wallpaper(
    window: tauri::WebviewWindow,
    enabled: bool,
) -> Result<String, String> {
    set_wallpaper_parent(&window, enabled)
}

#[cfg(target_os = "windows")]
fn set_wallpaper_parent(window: &tauri::WebviewWindow, enabled: bool) -> Result<String, String> {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowW, SMTO_NORMAL, SendMessageTimeoutW, SetParent,
    };
    use windows::core::w;

    let hwnd = HWND(window.hwnd().map_err(|e| e.to_string())?.0 as _);

    if !enabled {
        // Re-attach to the desktop root → a normal top-level overlay again.
        unsafe { SetParent(hwnd, None) }.map_err(|e| e.to_string())?;
        return Ok("detached from the wallpaper (normal overlay)".to_string());
    }

    // 1) Ask Progman to spawn the WorkerW that hosts the wallpaper behind the desktop icons. The
    //    undocumented 0x052C message is the standard wallpaper-host trick.
    let progman = unsafe { FindWindowW(w!("Progman"), None) }.map_err(|e| e.to_string())?;
    let mut spawn_result: usize = 0;
    unsafe {
        SendMessageTimeoutW(
            progman,
            0x052C,
            WPARAM(0),
            LPARAM(0),
            SMTO_NORMAL,
            1000,
            Some(&mut spawn_result as *mut usize as *mut _),
        );
    }
    // 2) Find the WorkerW that is the wallpaper surface (the one whose sibling hosts SHELLDLL_DefView,
    //    the desktop-icon layer). EnumWindows writes the match back through the LPARAM out-pointer.
    //    The 0x052C message spawns that WorkerW asynchronously, so it can still be missing for a few
    //    dozen ms after SendMessageTimeoutW returns — most visibly under `tauri dev`, where an HMR
    //    reload re-applies the layer before the shell has settled (the "WorkerW host not found"
    //    error). Poll briefly (≤ ~270 ms) instead of giving up on the first miss.
    let mut worker = HWND::default();
    for attempt in 0..10 {
        unsafe {
            let _ = EnumWindows(
                Some(enum_find_workerw),
                LPARAM(&mut worker as *mut HWND as isize),
            );
        }
        if !worker.is_invalid() {
            break;
        }
        if attempt < 9 {
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
    }
    if worker.is_invalid() {
        return Err("WorkerW (wallpaper host) not found".to_string());
    }
    unsafe { SetParent(hwnd, Some(worker)) }.map_err(|e| e.to_string())?;
    Ok(format!("parented to WorkerW {:#x}", worker.0 as usize))
}

// EnumWindows callback: a top-level window hosting a SHELLDLL_DefView child is the desktop icon host;
// the WorkerW immediately AFTER it (its next sibling) is the wallpaper surface we want to parent to.
#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_find_workerw(
    top: windows::Win32::Foundation::HWND,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::core::BOOL {
    use windows::Win32::Foundation::{HWND, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::FindWindowExW;
    use windows::core::{BOOL, w};

    let defview =
        unsafe { FindWindowExW(Some(top), None, w!("SHELLDLL_DefView"), None) }.unwrap_or_default();
    if !defview.is_invalid()
        && let Ok(worker) = unsafe { FindWindowExW(None, Some(top), w!("WorkerW"), None) }
        && !worker.is_invalid()
    {
        unsafe { *(lparam.0 as *mut HWND) = worker };
        return BOOL(0); // found → stop enumerating
    }
    TRUE // keep going
}

#[cfg(not(target_os = "windows"))]
fn set_wallpaper_parent(_window: &tauri::WebviewWindow, _enabled: bool) -> Result<String, String> {
    Err("the wallpaper layer is only available on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::ScreenRect;

    #[test]
    fn contains_includes_origin_excludes_far_edge() {
        let r = ScreenRect {
            x: 10.0,
            y: 20.0,
            w: 100.0,
            h: 50.0,
        };
        assert!(r.contains(10.0, 20.0)); // top-left corner included
        assert!(r.contains(60.0, 40.0)); // inside
        assert!(!r.contains(110.0, 40.0)); // right edge (x + w) excluded
        assert!(!r.contains(60.0, 70.0)); // bottom edge (y + h) excluded
        assert!(!r.contains(5.0, 40.0)); // left of the rect
    }
}
