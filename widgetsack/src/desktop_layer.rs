//! The "On desktop" overlay layer: below application windows like the 'bottom' layer, but — unlike
//! it — still visible (and clickable) after Show Desktop / Win+D. A port of Rainmeter's
//! `ZPOSITION_ONDESKTOP` (Library/System.cpp `CheckDesktopState` / `PrepareHelperWindow`).
//!
//! Show Desktop doesn't minimize a skip-taskbar overlay — Explorer raises the desktop-icons host
//! (Progman on Windows 11 24H2+, else the WorkerW holding SHELLDLL_DefView) to the top of the
//! non-topmost band, covering it. Windows has no "survive Show Desktop" flag (Old New Thing,
//! 2011-06-17), so we detect the state and react:
//!
//! - DETECT: a hidden SENTINEL window parked at `HWND_BOTTOM` (its wndproc refuses any other
//!   z-order). Normally the icon host sits below it; while the desktop is shown the icon host is
//!   ABOVE it. A `EVENT_SYSTEM_FOREGROUND` hook (the shell becoming foreground) checks immediately,
//!   with a timer as the fallback: 250 ms idle, 100 ms while shown.
//! - REACT: while shown, every registered overlay is slotted just under the backmost topmost window
//!   (above the icon host, below the taskbar). Those calls use `SWP_NOSENDCHANGING`, which skips
//!   `WM_WINDOWPOSCHANGING` — so tao's ALWAYS_ON_BOTTOM handler (which rewrites every z-order change
//!   to `HWND_BOTTOM`) doesn't undo them, while it keeps guarding the overlay the rest of the time.
//!   When the desktop is left, the overlays go back to `HWND_BOTTOM`.
//!
//! Unlike the experimental 'wallpaper' layer (a WorkerW child, under SHELLDLL_DefView, so the icons
//! eat every click) the overlays stay ordinary top-level windows, so the click-through watcher's
//! per-widget interactivity keeps working.
//!
//! Win32 anti-corruption edge (mirrors displaywatch.rs / windowmgr.rs): the `unsafe` calls live here,
//! on one named pump thread (WINEVENT_OUTOFCONTEXT + WM_TIMER need a message loop). HWNDs cross
//! threads as `usize`. The decisions are pure seams, tested below. No-op off Windows.

use std::collections::BTreeMap;
use std::sync::Mutex;
use tauri::Manager;

/// Overlay windows in the 'desktop' layer: window label → HWND.
static OVERLAYS: Mutex<BTreeMap<String, usize>> = Mutex::new(BTreeMap::new());

fn overlay_hwnds() -> Vec<usize> {
    let map = OVERLAYS.lock().unwrap_or_else(|e| e.into_inner());
    map.values().copied().collect()
}

/// One top-level window in a z-order snapshot (top → bottom, as `EnumWindows` reports them).
#[derive(Clone, Copy, Debug, PartialEq)]
struct ZWindow {
    hwnd: usize,
    topmost: bool,
}

/// PURE SEAM: the window that holds the desktop icons, from a shell probe. On 24H2+ SHELLDLL_DefView
/// stays inside the shell window (Progman), which is then the host. Before 24H2 the host is the
/// top-level WorkerW that DefView moved into; an unsplit legacy shell (DefView still in Progman) has
/// no separate host to compare against, so there is none (Rainmeter `GetDesktopIconsHostWindow`).
fn icon_host(
    shell: usize,
    defview_in_shell: bool,
    shell_hosts_icons: bool,
    workerw_host: Option<usize>,
) -> Option<usize> {
    if defview_in_shell {
        return shell_hosts_icons.then_some(shell);
    }
    workerw_host
}

/// PURE SEAM: whether `overlay` currently sits above `host` in the z-order snapshot. Unknown windows
/// count as "above" so we never act on a half-built snapshot.
fn is_above(z: &[ZWindow], overlay: usize, host: usize) -> bool {
    let pos = |h: usize| z.iter().position(|w| w.hwnd == h);
    match (pos(overlay), pos(host)) {
        (Some(o), Some(h)) => o < h,
        _ => true,
    }
}

fn desktop_shown(z: &[ZWindow], host: usize, sentinel: usize) -> bool {
    matches!(
        (z.iter().position(|w| w.hwnd == host), z.iter().position(|w| w.hwnd == sentinel)),
        (Some(host), Some(sentinel)) if host < sentinel
    )
}

#[derive(Debug, PartialEq)]
enum Placement {
    Raise(Vec<usize>, usize),
    Lower(Vec<usize>),
}

/// Use live registration and shell state when the UI thread runs. Coalescing must preserve a final
/// lower, and queued work must never touch windows that have since left this layer.
fn placement_plan(current: Vec<usize>, shown: bool, host: Option<usize>) -> Option<Placement> {
    if current.is_empty() {
        None
    } else if shown {
        host.map(|host| Placement::Raise(current, host))
    } else {
        Some(Placement::Lower(current))
    }
}

/// PURE SEAM: candidates to insert a raised overlay AFTER, best first — the topmost windows above
/// `host`, backmost first (so the overlay lands at the top of the normal band: over the icon host,
/// still under the taskbar). Rainmeter walks the same way and takes the first one SetWindowPos
/// accepts. Empty → fall back to `HWND_TOP`.
fn raise_anchors(z: &[ZWindow], host: usize, ours: &[usize]) -> Vec<usize> {
    let end = z.iter().position(|w| w.hwnd == host).unwrap_or(z.len());
    z[..end]
        .iter()
        .rev()
        .filter(|w| w.topmost && !ours.contains(&w.hwnd))
        .map(|w| w.hwnd)
        .collect()
}

/// Frontend → backend: put the CALLING overlay in (or take it out of) the 'desktop' layer. The
/// frontend keeps tao's always-on-bottom on for this layer; this only adds the Show Desktop
/// handling on top. Returns a human-readable status for the studio's layer line.
#[tauri::command]
pub fn set_overlay_desktop(window: tauri::WebviewWindow, enabled: bool) -> Result<String, String> {
    let hwnd = imp::window_hwnd(&window)?;
    let label = window.label().to_string();
    if enabled {
        imp::ensure_watcher(window.app_handle().clone())?;
    }
    {
        let mut map = OVERLAYS.lock().unwrap_or_else(|e| e.into_inner());
        if enabled {
            map.insert(label, hwnd);
        } else if map.remove(&label).is_none() {
            return Ok("not in the desktop layer".to_string());
        }
    }
    if !enabled && imp::is_shown() {
        // Only undo our own lift: outside Show Desktop the window is wherever its NEW layer is about
        // to put it, and an HWND_BOTTOM landing after the 'top' layer's HWND_TOPMOST would demote it.
        imp::lower(hwnd);
    }
    imp::request_check();
    Ok(if enabled {
        "below windows, kept visible on Show Desktop".to_string()
    } else {
        "left the desktop layer".to_string()
    })
}

/// Drop a destroyed window (called from the app's `WindowEvent::Destroyed` handler).
pub fn forget_window(label: &str) {
    let removed = OVERLAYS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(label)
        .is_some();
    if removed {
        imp::request_check();
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        Placement, ZWindow, desktop_shown, icon_host, is_above, overlay_hwnds, placement_plan,
        raise_anchors,
    };
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        DefWindowProcW, FindWindowExW, GWL_EXSTYLE, GetClassNameW, GetShellWindow, GetWindowLongW,
        GetWindowThreadProcessId, HWND_BOTTOM, HWND_TOP, IsWindowVisible, KillTimer, PostMessageW,
        SET_WINDOW_POS_FLAGS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSENDCHANGING,
        SWP_NOSIZE, SWP_NOZORDER, SetTimer, SetWindowPos, WINDOWPOS, WM_APP, WM_TIMER,
        WM_WINDOWPOSCHANGING, WS_EX_TOPMOST,
    };
    use windows::core::{PCWSTR, w};

    const SENTINEL_CLASS: PCWSTR = w!("WidgetsackDesktopSentinel");
    /// Posted to the sentinel to run a check now (a layer was just enabled/disabled).
    const WM_CHECK_NOW: u32 = WM_APP + 1;
    const TIMER_ID: usize = 1;
    const INTERVAL_IDLE_MS: u32 = 250;
    const INTERVAL_SHOWN_MS: u32 = 100;
    /// Rainmeter's `ZPOS_FLAGS`: z-order only, no activation, and NO `WM_WINDOWPOSCHANGING` (so
    /// neither tao's ALWAYS_ON_BOTTOM rewrite nor the sentinel's own guard intercepts us). Overlay
    /// placements run on their owning UI thread, after validating the current registration.
    const ZPOS: SET_WINDOW_POS_FLAGS = SET_WINDOW_POS_FLAGS(
        SWP_NOMOVE.0 | SWP_NOSIZE.0 | SWP_NOOWNERZORDER.0 | SWP_NOACTIVATE.0 | SWP_NOSENDCHANGING.0,
    );

    static STARTED: OnceLock<Result<(), String>> = OnceLock::new();
    static SENTINEL: AtomicUsize = AtomicUsize::new(0);
    static SHOWN: AtomicBool = AtomicBool::new(false);
    static PLACEMENT_PENDING: AtomicBool = AtomicBool::new(false);
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    /// Start the sentinel + hook pump thread once; waits for the sentinel so the first check works.
    pub fn ensure_watcher(app: tauri::AppHandle) -> Result<(), String> {
        APP.get_or_init(|| app);
        STARTED
            .get_or_init(|| {
                let (tx, rx) = std::sync::mpsc::channel();
                std::thread::Builder::new()
                    .name("desktoplayer".into())
                    .spawn(move || pump(tx))
                    .map_err(|e| e.to_string())?;
                rx.recv().map_err(|e| e.to_string())?
            })
            .clone()
    }

    pub fn window_hwnd(window: &tauri::WebviewWindow) -> Result<usize, String> {
        Ok(window.hwnd().map_err(|e| e.to_string())?.0 as usize)
    }

    pub fn request_check() {
        let sentinel = SENTINEL.load(Ordering::SeqCst);
        if sentinel != 0 {
            let _ = unsafe {
                PostMessageW(
                    Some(HWND(sentinel as _)),
                    WM_CHECK_NOW,
                    WPARAM(0),
                    LPARAM(0),
                )
            };
        }
    }

    pub fn is_shown() -> bool {
        SHOWN.load(Ordering::SeqCst)
    }

    /// Back to the bottom of the z-order (where tao's always-on-bottom keeps it).
    pub fn lower(hwnd: usize) {
        let _ = unsafe { SetWindowPos(HWND(hwnd as _), Some(HWND_BOTTOM), 0, 0, 0, 0, ZPOS) };
    }

    fn pump(ready: std::sync::mpsc::Sender<Result<(), String>>) {
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::Accessibility::SetWinEventHook;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DispatchMessageW, EVENT_SYSTEM_FOREGROUND, GetMessageW, MSG,
            RegisterClassW, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WNDCLASSW, WS_DISABLED,
            WS_EX_TOOLWINDOW, WS_POPUP,
        };

        unsafe {
            let hinstance = GetModuleHandleW(None).unwrap_or_default();
            let wc = WNDCLASSW {
                lpfnWndProc: Some(sentinel_wndproc),
                hInstance: hinstance.into(),
                lpszClassName: SENTINEL_CLASS,
                ..Default::default()
            };
            if RegisterClassW(&wc) == 0 {
                let _ = ready.send(Err(format!(
                    "RegisterClassW failed: {}",
                    std::io::Error::last_os_error()
                )));
                return;
            }
            // Never shown, disabled, tool window: invisible, unclickable, out of alt-tab — but a real
            // top-level window, so it has a z-order position for the icon host to pass.
            let sentinel = match CreateWindowExW(
                WS_EX_TOOLWINDOW,
                SENTINEL_CLASS,
                w!("widgetsack desktop sentinel"),
                WS_POPUP | WS_DISABLED,
                0,
                0,
                0,
                0,
                None,
                None,
                Some(hinstance.into()),
                None,
            ) {
                Ok(h) => h,
                Err(err) => {
                    let _ = ready.send(Err(format!("CreateWindowExW failed: {err}")));
                    return;
                }
            };
            // Our own window on our own thread: synchronous is fine.
            let _ = SetWindowPos(sentinel, Some(HWND_BOTTOM), 0, 0, 0, 0, ZPOS);
            SENTINEL.store(sentinel.0 as usize, Ordering::SeqCst);
            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(foreground_proc),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );
            if hook.is_invalid() {
                crate::log::warn(
                    "desktop_layer",
                    "foreground hook failed; Show Desktop is detected by polling only",
                )
                .emit();
            }
            SetTimer(Some(sentinel), TIMER_ID, INTERVAL_IDLE_MS, None);
            let _ = ready.send(Ok(()));

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                let _ = DispatchMessageW(&msg);
            }
        }
    }

    unsafe extern "system" fn sentinel_wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            // Stay parked at the bottom: refuse every z-order change we didn't make ourselves (ours
            // use SWP_NOSENDCHANGING and never get here).
            WM_WINDOWPOSCHANGING if lparam.0 != 0 => {
                let pos = unsafe { &mut *(lparam.0 as *mut WINDOWPOS) };
                pos.flags |= SWP_NOZORDER;
                LRESULT(0)
            }
            WM_TIMER if wparam.0 == TIMER_ID => {
                check();
                LRESULT(0)
            }
            WM_CHECK_NOW => {
                check();
                LRESULT(0)
            }
            _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
        }
    }

    // The shell taking the foreground is how Show Desktop starts: check right away, retrying a few
    // times because Explorer reorders a few ms after the event (Rainmeter `MyWinEventProc`). Any
    // other foreground change while shown (the user picked an app) also ends it — check once.
    unsafe extern "system" fn foreground_proc(
        _hook: windows::Win32::UI::Accessibility::HWINEVENTHOOK,
        _event: u32,
        hwnd: HWND,
        _id_object: i32,
        _id_child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if SHOWN.load(Ordering::SeqCst) || !is_shell_window(hwnd) {
            check();
            return;
        }
        for _ in 0..5 {
            if check() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    fn is_shell_window(hwnd: HWND) -> bool {
        let shell = unsafe { GetShellWindow() };
        if hwnd == shell {
            return true;
        }
        class_name(hwnd) == "WorkerW" && same_process(hwnd, shell)
    }

    fn class_name(hwnd: HWND) -> String {
        let mut buf = [0u16; 64];
        let n = unsafe { GetClassNameW(hwnd, &mut buf) } as usize;
        String::from_utf16_lossy(&buf[..n.min(buf.len())])
    }

    fn same_process(a: HWND, b: HWND) -> bool {
        let (mut pa, mut pb) = (0u32, 0u32);
        unsafe {
            GetWindowThreadProcessId(a, Some(&mut pa));
            GetWindowThreadProcessId(b, Some(&mut pb));
        }
        pa != 0 && pa == pb
    }

    /// Windows 11 24H2 (build 26100.2454+) keeps SHELLDLL_DefView inside Progman; detected the way
    /// Rainmeter does, by an export that only exists from that build on.
    fn shell_hosts_icons() -> bool {
        use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
        use windows::core::s;
        static RESULT: OnceLock<bool> = OnceLock::new();
        *RESULT.get_or_init(|| unsafe {
            GetModuleHandleW(w!("user32"))
                .ok()
                .and_then(|m| GetProcAddress(m, s!("GetCurrentMonitorTopologyId")))
                .is_some()
        })
    }

    fn find_icon_host() -> Option<HWND> {
        let shell = unsafe { GetShellWindow() };
        if shell.is_invalid() {
            return None; // Explorer isn't the shell (or is restarting)
        }
        let has_defview = |parent: HWND| {
            unsafe { FindWindowExW(Some(parent), None, w!("SHELLDLL_DefView"), None) }
                .is_ok_and(|h| !h.is_invalid())
        };
        let defview_in_shell = has_defview(shell);
        let workerw_host = if defview_in_shell {
            None
        } else {
            let mut after: Option<HWND> = None;
            loop {
                let Ok(worker) = (unsafe { FindWindowExW(None, after, w!("WorkerW"), None) })
                else {
                    break None;
                };
                if worker.is_invalid() {
                    break None;
                }
                if unsafe { IsWindowVisible(worker) }.as_bool()
                    && same_process(worker, shell)
                    && has_defview(worker)
                {
                    break Some(worker.0 as usize);
                }
                after = Some(worker);
            }
        };
        icon_host(
            shell.0 as usize,
            defview_in_shell,
            shell_hosts_icons(),
            workerw_host,
        )
        .map(|h| HWND(h as _))
    }

    /// The top-level z-order, top → bottom.
    fn zorder() -> Vec<ZWindow> {
        use windows::Win32::UI::WindowsAndMessaging::{GW_HWNDNEXT, GetTopWindow, GetWindow};
        let mut out = Vec::with_capacity(256);
        let mut cur = unsafe { GetTopWindow(None) }.ok();
        while let Some(h) = cur.filter(|h| !h.is_invalid()) {
            let ex = unsafe { GetWindowLongW(h, GWL_EXSTYLE) } as u32;
            out.push(ZWindow {
                hwnd: h.0 as usize,
                topmost: ex & WS_EX_TOPMOST.0 != 0,
            });
            if out.len() > 10_000 {
                break; // a z-order changing under us can't loop us forever
            }
            cur = unsafe { GetWindow(h, GW_HWNDNEXT) }.ok();
        }
        out
    }

    /// Re-evaluate the Show Desktop state and (re)place the overlays. Returns whether the state
    /// changed. Runs only on the pump thread (timer, posted check, foreground hook).
    fn check() -> bool {
        let overlays = overlay_hwnds();
        let sentinel = HWND(SENTINEL.load(Ordering::SeqCst) as _);
        if overlays.is_empty() {
            let was = SHOWN.swap(false, Ordering::SeqCst);
            unsafe {
                let _ = KillTimer(Some(sentinel), TIMER_ID);
            }
            return was;
        }
        let host = find_icon_host();
        // The icon host has moved ABOVE our bottom-parked sentinel ⇔ the desktop is being shown.
        let shown = host.is_some_and(|host| {
            unsafe { IsWindowVisible(host) }.as_bool()
                && desktop_shown(&zorder(), host.0 as usize, sentinel.0 as usize)
        });
        let was = SHOWN.swap(shown, Ordering::SeqCst);
        if shown || was {
            queue_placement();
        }
        // Also restart the timer after the last desktop overlay was removed and a new one joined.
        let interval = if shown {
            INTERVAL_SHOWN_MS
        } else {
            INTERVAL_IDLE_MS
        };
        unsafe { SetTimer(Some(sentinel), TIMER_ID, interval, None) };
        if was != shown {
            crate::log::info("desktop_layer", "show desktop state changed")
                .field("shown", shown)
                .field("overlays", overlays.len())
                .emit();
        }
        was != shown
    }

    fn queue_placement() {
        if let Some(app) = APP.get() {
            if PLACEMENT_PENDING.swap(true, Ordering::SeqCst) {
                return;
            }
            if app
                .run_on_main_thread(move || {
                    PLACEMENT_PENDING.store(false, Ordering::SeqCst);
                    let current = overlay_hwnds();
                    let shown = is_shown();
                    let host = shown.then(find_icon_host).flatten().map(|h| h.0 as usize);
                    match placement_plan(current, shown, host) {
                        Some(Placement::Raise(targets, host)) => raise(&targets, host),
                        Some(Placement::Lower(targets)) => {
                            for hwnd in targets {
                                lower(hwnd);
                            }
                        }
                        None => {}
                    }
                })
                .is_err()
            {
                PLACEMENT_PENDING.store(false, Ordering::SeqCst);
            }
        }
    }

    /// Slot every overlay that isn't already above the icon host just under the backmost topmost
    /// window. Re-run on each tick while shown, so an overlay something pushed back down (tao's
    /// bottom guard on a stray z-order change) comes back within 100 ms.
    fn raise(overlays: &[usize], host: usize) {
        let z = zorder();
        let anchors = raise_anchors(&z, host, overlays);
        for &o in overlays {
            if is_above(&z, o, host) {
                continue;
            }
            let hwnd = HWND(o as _);
            let placed = anchors.iter().any(|&a| unsafe {
                SetWindowPos(hwnd, Some(HWND(a as _)), 0, 0, 0, 0, ZPOS).is_ok()
            });
            if !placed {
                let _ = unsafe { SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, ZPOS) };
            }
        }
    }

    #[cfg(test)]
    mod native_tests {
        use super::*;
        use windows::Win32::Foundation::{POINT, RECT};
        use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR};
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY,
            VK_LWIN,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, DispatchMessageW, MSG, PM_REMOVE, PeekMessageW,
            RegisterClassW, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP, WS_VISIBLE,
            WindowFromPoint,
        };

        struct Cleanup {
            windows: Vec<HWND>,
            toggled: bool,
        }

        impl Drop for Cleanup {
            fn drop(&mut self) {
                if self.toggled {
                    toggle_desktop();
                }
                for hwnd in &self.windows {
                    super::super::forget_window(&format!("native-smoke-{}", hwnd.0 as usize));
                    let _ = unsafe { DestroyWindow(*hwnd) };
                }
            }
        }

        fn toggle_desktop() {
            let inputs = [
                (VK_LWIN, false),
                (VIRTUAL_KEY(0x44), false),
                (VIRTUAL_KEY(0x44), true),
                (VK_LWIN, true),
            ]
            .map(|(key, up)| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: key,
                        dwFlags: if up {
                            KEYEVENTF_KEYUP
                        } else {
                            Default::default()
                        },
                        ..Default::default()
                    },
                },
            });
            assert_eq!(
                unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) },
                4,
                "Win+D input was rejected"
            );
        }

        fn wait_for(mut condition: impl FnMut() -> bool) {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                let mut msg = MSG::default();
                unsafe {
                    while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                        DispatchMessageW(&msg);
                    }
                }
                if condition() {
                    return;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "desktop state did not settle"
                );
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }

        #[test]
        #[ignore = "interactive Windows smoke: briefly toggles Show Desktop and creates one temporary window per monitor"]
        fn native_desktop_smoke() {
            unsafe extern "system" fn overlay_proc(
                hwnd: HWND,
                msg: u32,
                wparam: WPARAM,
                lparam: LPARAM,
            ) -> LRESULT {
                if msg == WM_WINDOWPOSCHANGING && lparam.0 != 0 {
                    // Model tao's always-on-bottom guard. Our lift must bypass this message.
                    unsafe {
                        (*(lparam.0 as *mut WINDOWPOS)).hwndInsertAfter = HWND_BOTTOM;
                    }
                }
                unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
            }
            unsafe extern "system" fn monitor(
                h: HMONITOR,
                _dc: HDC,
                rc: *mut RECT,
                data: LPARAM,
            ) -> windows::core::BOOL {
                let _ = h;
                unsafe {
                    (*(data.0 as *mut Vec<RECT>)).push(*rc);
                }
                windows::core::BOOL(1)
            }
            unsafe {
                let mut cleanup = Cleanup {
                    windows: Vec::new(),
                    toggled: false,
                };
                let (tx, rx) = std::sync::mpsc::channel();
                std::thread::spawn(move || pump(tx));
                rx.recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap()
                    .unwrap();
                let instance = GetModuleHandleW(None).unwrap();
                let class = w!("WidgetsackNativeDesktopSmoke");
                assert_ne!(
                    RegisterClassW(&WNDCLASSW {
                        lpfnWndProc: Some(overlay_proc),
                        hInstance: instance.into(),
                        lpszClassName: class,
                        ..Default::default()
                    }),
                    0
                );
                let mut monitors = Vec::<RECT>::new();
                EnumDisplayMonitors(
                    None,
                    None,
                    Some(monitor),
                    LPARAM(&mut monitors as *mut _ as isize),
                )
                .ok()
                .unwrap();
                assert!(!monitors.is_empty());
                let mut points = Vec::new();
                for rc in monitors {
                    let x = (rc.left + rc.right) / 2;
                    let y = (rc.top + rc.bottom) / 2;
                    let hwnd = CreateWindowExW(
                        WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                        class,
                        w!("widgetsack native smoke"),
                        WS_POPUP | WS_VISIBLE,
                        x,
                        y,
                        64,
                        64,
                        None,
                        None,
                        Some(instance.into()),
                        None,
                    )
                    .unwrap();
                    cleanup.windows.push(hwnd);
                    points.push(POINT {
                        x: x + 16,
                        y: y + 16,
                    });
                    super::super::OVERLAYS
                        .lock()
                        .unwrap()
                        .insert(format!("native-smoke-{}", hwnd.0 as usize), hwnd.0 as usize);
                    lower(hwnd.0 as usize);
                }
                // A second instance's sentinel with the same class must not mask our own.
                let other = CreateWindowExW(
                    WS_EX_TOOLWINDOW,
                    SENTINEL_CLASS,
                    w!("other instance"),
                    WS_POPUP,
                    0,
                    0,
                    0,
                    0,
                    None,
                    None,
                    Some(instance.into()),
                    None,
                )
                .unwrap();
                cleanup.windows.push(other);
                let host = find_icon_host().expect("Explorer desktop icons host");
                check();
                let initial = is_shown();
                let diagnostic = || {
                    let z = zorder();
                    let sentinel = SENTINEL.load(Ordering::SeqCst);
                    eprintln!(
                        "desktop smoke: shown={} host={:?} sentinel={:?} overlays={:?} foreground={}",
                        is_shown(),
                        z.iter().position(|w| w.hwnd == host.0 as usize),
                        z.iter().position(|w| w.hwnd == sentinel),
                        targets_for_diagnostics(&z),
                        class_name(windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow())
                    );
                };
                diagnostic();
                if !initial {
                    toggle_desktop();
                    cleanup.toggled = true;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
                check();
                diagnostic();
                wait_for(|| {
                    check();
                    is_shown()
                });
                let targets = overlay_hwnds();
                raise(&targets, host.0 as usize);
                for (&hwnd, point) in cleanup.windows.iter().zip(points) {
                    assert!(is_above(&zorder(), hwnd.0 as usize, host.0 as usize));
                    assert_eq!(
                        WindowFromPoint(point),
                        hwnd,
                        "desktop icons or another window intercepts clicks"
                    );
                }
                eprintln!(
                    "native Show Desktop visibility and hit testing passed for {} overlay(s)",
                    targets.len()
                );
                if cleanup.toggled {
                    toggle_desktop();
                    cleanup.toggled = false;
                    wait_for(|| {
                        check();
                        !is_shown()
                    });
                }
                for hwnd in targets {
                    lower(hwnd);
                }
            }
        }

        fn targets_for_diagnostics(z: &[ZWindow]) -> Vec<Option<usize>> {
            overlay_hwnds()
                .iter()
                .map(|h| z.iter().position(|w| w.hwnd == *h))
                .collect()
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    pub fn window_hwnd(_window: &tauri::WebviewWindow) -> Result<usize, String> {
        Err("the desktop layer is only available on Windows".to_string())
    }
    pub fn ensure_watcher(_app: tauri::AppHandle) -> Result<(), String> {
        Err("the desktop layer is only available on Windows".to_string())
    }
    pub fn request_check() {}
    pub fn is_shown() -> bool {
        false
    }
    pub fn lower(_hwnd: usize) {}
}

#[cfg(test)]
mod tests {
    use super::{
        Placement, ZWindow, desktop_shown, icon_host, is_above, placement_plan, raise_anchors,
    };

    fn z(list: &[(usize, bool)]) -> Vec<ZWindow> {
        list.iter()
            .map(|&(hwnd, topmost)| ZWindow { hwnd, topmost })
            .collect()
    }

    #[test]
    fn icon_host_is_progman_on_24h2_and_the_workerw_before_it() {
        // 24H2+: DefView lives in Progman, which is the host.
        assert_eq!(icon_host(0x10, true, true, None), Some(0x10));
        // Pre-24H2, split shell: the WorkerW holding DefView.
        assert_eq!(icon_host(0x10, false, false, Some(0x20)), Some(0x20));
        // Pre-24H2, unsplit shell (DefView still in Progman): nothing to compare against.
        assert_eq!(icon_host(0x10, true, false, Some(0x20)), None);
        // No DefView anywhere (Explorer restarting).
        assert_eq!(icon_host(0x10, false, true, None), None);
    }

    #[test]
    fn overlay_above_host_only_when_earlier_in_the_zorder() {
        let order = z(&[(1, true), (2, false), (3, false), (4, false)]);
        assert!(is_above(&order, 2, 3));
        assert!(!is_above(&order, 4, 3));
        // Not in the snapshot (destroyed / raced): never act on it.
        assert!(is_above(&order, 9, 3));
        assert!(is_above(&order, 2, 9));
    }

    #[test]
    fn raise_anchors_are_the_topmost_windows_above_the_host_backmost_first() {
        // taskbar(1,T) tooltip(2,T) app(3) host(4) overlay(5) sentinel(6)
        let order = z(&[
            (1, true),
            (2, true),
            (3, false),
            (4, false),
            (5, false),
            (6, false),
        ]);
        assert_eq!(raise_anchors(&order, 4, &[5]), vec![2, 1]);
    }

    #[test]
    fn raise_anchors_skip_our_own_windows_and_fall_back_to_empty() {
        // Our overlay was once made topmost ('top' layer leftovers): never anchor on ourselves.
        let order = z(&[(5, true), (4, false)]);
        assert!(raise_anchors(&order, 4, &[5]).is_empty());
        // Host missing from the snapshot: consider the whole list.
        let order = z(&[(1, true), (3, false)]);
        assert_eq!(raise_anchors(&order, 99, &[]), vec![1]);
    }

    #[test]
    fn desktop_detection_uses_this_instances_sentinel_and_complete_snapshots() {
        let order = z(&[(10, false), (20, false), (30, false)]);
        // Another instance's sentinel (20) may appear before ours (30).
        assert!(desktop_shown(&order, 10, 30));
        assert!(!desktop_shown(&order, 30, 10));
        assert!(!desktop_shown(&order, 10, 99));
        assert!(!desktop_shown(&order, 99, 30));
    }

    #[test]
    fn queued_placements_use_live_membership_and_preserve_the_final_lower() {
        assert_eq!(
            placement_plan(vec![2, 3], true, Some(10)),
            Some(Placement::Raise(vec![2, 3], 10))
        );
        assert_eq!(
            placement_plan(vec![2, 3], false, None),
            Some(Placement::Lower(vec![2, 3]))
        );
        assert_eq!(placement_plan(vec![], true, Some(10)), None);
        assert_eq!(placement_plan(vec![2], true, None), None);
    }
}
