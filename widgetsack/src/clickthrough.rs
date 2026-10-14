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
    app: AppHandle,
    state: tauri::State<'_, InteractiveRects>,
    label: String,
    rects: Vec<ScreenRect>,
) {
    let alive = || app.get_webview_window(&label).is_some();
    store_rects(&state, label.clone(), rects, alive);
}

/// Store (or, for an empty list, clear) `label`'s rects — unless `alive()` says the window is gone.
/// `alive` runs UNDER the rects lock: Tauri drops a window from its registry before the `Destroyed`
/// handler's `forget_window` takes this lock, so a call still in flight from a dying webview can't
/// re-insert rects after that cleanup (which would keep the cursor watcher from ever idling).
fn store_rects(
    state: &InteractiveRects,
    label: String,
    rects: Vec<ScreenRect>,
    alive: impl FnOnce() -> bool,
) {
    // Recover from a poisoned lock (a prior panic while holding it) instead of panicking again —
    // the stored rects are plain data, so a poisoned guard is still safe to use.
    let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if !alive() {
        return;
    }
    if rects.is_empty() {
        map.remove(&label);
    } else {
        map.insert(label, rects);
    }
}

/// Drop a destroyed window's rects so the watcher can idle again (nothing else ever clears them —
/// the frontend that would send an empty list died with the window). Called from the app's
/// `WindowEvent::Destroyed` handler.
pub fn forget_window(state: &InteractiveRects, label: &str) {
    let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
    map.remove(label);
}

/// The cursor in physical screen pixels. On Windows this reads it on the calling thread:
/// `AppHandle::cursor_position` is a round trip through the main thread, which at 60 Hz kept the UI
/// thread busy and stalled this watcher whenever the UI thread hung.
#[cfg(target_os = "windows")]
fn cursor_position<R: Runtime>(_app: &AppHandle<R>) -> Option<(f64, f64)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT::default();
    // SAFETY: GetCursorPos writes only to the POINT we own for the duration of the call.
    unsafe { GetCursorPos(&mut point) }.ok()?;
    Some((f64::from(point.x), f64::from(point.y)))
}

#[cfg(not(target_os = "windows"))]
fn cursor_position<R: Runtime>(app: &AppHandle<R>) -> Option<(f64, f64)> {
    app.cursor_position().ok().map(|pos| (pos.x, pos.y))
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
            // A label that left the map (window destroyed / rects cleared) must not keep a cached
            // "ignoring" verdict: a re-created window with the same label is born click-through and
            // would otherwise get no set_ignore_cursor_events(false) while the cursor sits over a rect.
            ignoring.retain(|label, _| map.contains_key(label));
            std::thread::sleep(Duration::from_millis(16));

            let Some((x, y)) = cursor_position(&app) else {
                continue;
            };
            // Re-read which labels still have rects: a rescue / whole-window-interactive call may have
            // forgotten one during the sleep, and applying this stale snapshot's verdict would put
            // click-through back on a window that was just made interactive.
            let live: Vec<String> = {
                let guard = app.state::<InteractiveRects>();
                let map = guard.0.lock().unwrap_or_else(|e| e.into_inner());
                map.keys().cloned().collect()
            };
            for (label, rects) in &map {
                if !live.contains(label) {
                    ignoring.remove(label);
                    continue;
                }
                let over = rects.iter().any(|r| r.contains(x, y));
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
        EnumWindows, FindWindowExW, FindWindowW, GetParent, SMTO_NORMAL, SendMessageTimeoutW,
        SetParent,
    };
    use windows::core::w;

    let hwnd = HWND(window.hwnd().map_err(|e| e.to_string())?.0 as _);

    if !enabled {
        // Already a top-level window (the common case: every refit re-applies the 'top'/'bottom'
        // layer and passes through here) → nothing to detach. Skip the SetParent: it runs on the
        // main thread and is a synchronous Win32 re-parent that is pure churn here — and a display
        // topology change (the moment refits fire) is exactly when the shell is busiest.
        // (`GetParent` is `Err` for a NULL parent in windows-rs.)
        if unsafe { GetParent(hwnd) }.is_err() {
            return Ok("already a normal overlay (no wallpaper parent)".to_string());
        }
        // Re-attach to the desktop root → a normal top-level overlay again.
        unsafe { SetParent(hwnd, None) }.map_err(|e| e.to_string())?;
        return Ok("detached from the wallpaper (normal overlay)".to_string());
    }

    // Already parented to a WorkerW? Then there is nothing to do — and this runs on the main thread
    // on every refit (topology tick, drift, scale change), where the Progman round trip + EnumWindows
    // polling below (up to ~1.3 s) is exactly the kind of UI-thread stall a display change turns
    // into a hang.
    if let Ok(parent) = unsafe { GetParent(hwnd) } {
        let mut class = [0u16; 32];
        let n =
            unsafe { windows::Win32::UI::WindowsAndMessaging::GetClassNameW(parent, &mut class) }
                as usize;
        if crate::display::wide_to_string(&class[..n.min(class.len())]) == "WorkerW" {
            return Ok(format!(
                "already parented to WorkerW {:#x}",
                parent.0 as usize
            ));
        }
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
    // 2) Find the WorkerW that is the wallpaper surface. Two shell layouts exist:
    //    - pre-24H2: 0x052C moves the desktop icons (SHELLDLL_DefView) into a new top-level WorkerW and
    //      spawns the wallpaper WorkerW as its NEXT top-level sibling;
    //    - Windows 11 24H2+ (build 26100+): SHELLDLL_DefView stays inside Progman and the wallpaper
    //      WorkerW is a CHILD of Progman, below DefView in the child z-order — so parenting to it puts
    //      the overlay on the wallpaper but behind the icons (the Lively / Wallpaper Engine 24H2 path).
    //    `wallpaper_host` (pure) picks between them. The 0x052C message spawns the WorkerW
    //    asynchronously, so it can still be missing for a few dozen ms after SendMessageTimeoutW
    //    returns — most visibly under `tauri dev`, where an HMR reload re-applies the layer before the
    //    shell has settled. Poll briefly (≤ ~270 ms) instead of giving up on the first miss.
    let mut host = None;
    for attempt in 0..10 {
        let mut probe = EnumProbe::default();
        unsafe {
            let _ = EnumWindows(
                Some(enum_find_workerw),
                LPARAM(&mut probe as *mut EnumProbe as isize),
            );
        }
        let progman_child = unsafe { FindWindowExW(Some(progman), None, w!("WorkerW"), None) }
            .ok()
            .filter(|h| !h.is_invalid());
        host = wallpaper_host(ShellProbe {
            defview_in_progman: probe.defview_host == Some(progman.0 as usize),
            progman_workerw: progman_child.map(|h| h.0 as usize),
            sibling_workerw: probe.sibling_workerw,
        });
        if host.is_some() {
            break;
        }
        if attempt < 9 {
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
    }
    let Some(host) = host else {
        return Err("WorkerW (wallpaper host) not found".to_string());
    };
    let (worker, kind) = match host {
        WallpaperHost::Sibling(h) => (HWND(h as _), "WorkerW"),
        WallpaperHost::ProgmanChild(h) => (HWND(h as _), "Progman's child WorkerW (24H2)"),
    };
    unsafe { SetParent(hwnd, Some(worker)) }.map_err(|e| e.to_string())?;
    Ok(format!("parented to {kind} {:#x}", worker.0 as usize))
}

/// What the shell-window probe found (raw HWND values).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct ShellProbe {
    /// SHELLDLL_DefView (the desktop icons) is hosted by Progman itself — the 24H2+ layout (or a
    /// pre-24H2 shell that hasn't split yet).
    defview_in_progman: bool,
    /// A WorkerW that is a child of Progman (24H2+: the wallpaper surface).
    progman_workerw: Option<usize>,
    /// The top-level WorkerW right after the DefView host (pre-24H2: the wallpaper surface).
    sibling_workerw: Option<usize>,
}

/// The window to parent the overlay to for the wallpaper layer.
#[derive(Clone, Copy, Debug, PartialEq)]
enum WallpaperHost {
    /// Pre-24H2: the top-level WorkerW sibling of the DefView host.
    Sibling(usize),
    /// 24H2+: Progman's child WorkerW (below SHELLDLL_DefView in Progman's child z-order).
    ProgmanChild(usize),
}

/// PURE SEAM: pick the wallpaper host from a shell probe. When the icons still live in Progman and
/// Progman has a WorkerW child, that child is the wallpaper (24H2) — a top-level WorkerW "after
/// Progman" there is unrelated. Otherwise the classic sibling WorkerW; `None` = not (yet) present.
fn wallpaper_host(probe: ShellProbe) -> Option<WallpaperHost> {
    match probe {
        ShellProbe {
            defview_in_progman: true,
            progman_workerw: Some(child),
            ..
        } => Some(WallpaperHost::ProgmanChild(child)),
        ShellProbe {
            defview_in_progman: false,
            sibling_workerw: Some(sibling),
            ..
        } => Some(WallpaperHost::Sibling(sibling)),
        _ => None,
    }
}

/// EnumWindows out-param: the top-level window hosting SHELLDLL_DefView, and the top-level WorkerW
/// immediately after it (if any).
#[cfg(target_os = "windows")]
#[derive(Default)]
struct EnumProbe {
    defview_host: Option<usize>,
    sibling_workerw: Option<usize>,
}

// EnumWindows callback: a top-level window hosting a SHELLDLL_DefView child is the desktop icon host;
// the WorkerW immediately AFTER it (its next sibling) is the pre-24H2 wallpaper surface.
#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_find_workerw(
    top: windows::Win32::Foundation::HWND,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::core::BOOL {
    use windows::Win32::Foundation::TRUE;
    use windows::Win32::UI::WindowsAndMessaging::FindWindowExW;
    use windows::core::{BOOL, w};

    let defview =
        unsafe { FindWindowExW(Some(top), None, w!("SHELLDLL_DefView"), None) }.unwrap_or_default();
    if defview.is_invalid() {
        return TRUE; // keep going
    }
    // SAFETY: lparam is the `&mut EnumProbe` set_wallpaper_parent passes for this call's duration.
    let probe = unsafe { &mut *(lparam.0 as *mut EnumProbe) };
    probe.defview_host = Some(top.0 as usize);
    probe.sibling_workerw = unsafe { FindWindowExW(None, Some(top), w!("WorkerW"), None) }
        .ok()
        .filter(|h| !h.is_invalid())
        .map(|h| h.0 as usize);
    BOOL(0) // found the icon host → stop enumerating
}

#[cfg(not(target_os = "windows"))]
fn set_wallpaper_parent(_window: &tauri::WebviewWindow, _enabled: bool) -> Result<String, String> {
    Err("the wallpaper layer is only available on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        InteractiveRects, ScreenRect, ShellProbe, WallpaperHost, store_rects, wallpaper_host,
    };

    #[test]
    fn wallpaper_host_prefers_progmans_child_workerw_on_24h2() {
        // 24H2: the icons stay in Progman and the wallpaper WorkerW is its child — even if some
        // unrelated top-level WorkerW happens to follow Progman.
        let probe = ShellProbe {
            defview_in_progman: true,
            progman_workerw: Some(0x20),
            sibling_workerw: Some(0x30),
        };
        assert_eq!(
            wallpaper_host(probe),
            Some(WallpaperHost::ProgmanChild(0x20))
        );
    }

    #[test]
    fn wallpaper_host_uses_the_sibling_workerw_before_24h2() {
        let probe = ShellProbe {
            defview_in_progman: false,
            progman_workerw: None,
            sibling_workerw: Some(0x30),
        };
        assert_eq!(wallpaper_host(probe), Some(WallpaperHost::Sibling(0x30)));
    }

    #[test]
    fn wallpaper_host_is_none_until_the_shell_has_spawned_a_wallpaper_workerw() {
        for probe in [
            ShellProbe::default(),
            // Icons in Progman but no child WorkerW yet (0x052C still in flight / unsplit legacy
            // shell): a top-level WorkerW after Progman is NOT the wallpaper surface.
            ShellProbe {
                defview_in_progman: true,
                progman_workerw: None,
                sibling_workerw: Some(0x30),
            },
            ShellProbe {
                defview_in_progman: false,
                progman_workerw: Some(0x20),
                sibling_workerw: None,
            },
        ] {
            assert_eq!(wallpaper_host(probe), None, "{probe:?}");
        }
    }

    #[test]
    fn rects_from_a_destroyed_window_are_not_reinserted() {
        let state = InteractiveRects::default();
        let rect = ScreenRect {
            x: 0.0,
            y: 0.0,
            w: 10.0,
            h: 10.0,
        };
        store_rects(&state, "overlay-1".into(), vec![rect], || false);
        assert!(state.0.lock().unwrap().is_empty());
        store_rects(&state, "overlay-1".into(), vec![rect], || true);
        assert_eq!(state.0.lock().unwrap()["overlay-1"], vec![rect]);
        store_rects(&state, "overlay-1".into(), vec![], || true);
        assert!(state.0.lock().unwrap().is_empty());
    }

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
