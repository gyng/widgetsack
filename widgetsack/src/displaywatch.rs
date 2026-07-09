//! Display-change watcher: a Rust-side fast path for instant recovery when the monitor topology
//! changes (a display DDC-switched back to this PC, unplugged/replugged, or a resolution change).
//!
//! `keepalive.rs` already respawns a hidden `main` every `RESPAWN_DELAY` (30s) whenever the app is
//! at zero windows, so an overlay that couldn't spawn (monitor not yet enumerated at logon, a
//! WebView2 hiccup, the 4K display switched away) eventually returns. But 30s is a long stare at an
//! empty desktop after flipping a monitor input back. This watcher closes that gap: it listens for
//! `WM_DISPLAYCHANGE` and — only when the app currently has NO windows — respawns `main` immediately,
//! re-running the overlay reconcile cycle the moment a monitor comes back.
//!
//! It acts ONLY on the zero-window case: if any webview is live, that window's own JS topology poller
//! (overlay.ts) handles the refit, so this stands down. This covers exactly the gap where no JS is
//! alive to notice the display returned.
//!
//! Win32 anti-corruption edge (mirrors windowmgr.rs): all `unsafe` and `windows::Win32::*` calls live
//! in this module. The watcher runs its own named thread with a `GetMessageW`/`DispatchMessageW`
//! pump — `WM_DISPLAYCHANGE` is only delivered to a window whose thread pumps messages, and the
//! clickthrough/keepalive threads have none. No-op off Windows.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Debounce after a display change before checking for zero windows. A topology change (unplug, DDC
/// input switch, resolution change) fires a BURST of `WM_DISPLAYCHANGE`, and the returning monitor
/// takes a beat to enumerate — wait for the dust to settle before respawning. Same pending-guard +
/// delayed-spawn shape as keepalive.rs's `on_zero_windows`, just far shorter (this IS the fast path).
const DEBOUNCE: Duration = Duration::from_secs(3);

/// One in-flight respawn attempt per display-change burst; reset on the main thread before the check.
static RESPAWN_PENDING: AtomicBool = AtomicBool::new(false);

/// Pure seam: given the app's current window count, whether a display change should trigger a `main`
/// respawn. Only the zero-window case — any live webview runs its own JS topology poller (overlay.ts),
/// so this Rust fast-path exists solely for the gap where no JS is alive to react. Tested below.
fn should_respawn_on_display_change(window_count: usize) -> bool {
    window_count == 0
}

/// Start the display-change watcher (idempotent — a second call is a no-op). Windows-only; a no-op
/// elsewhere. Call once in `setup`, next to `windowmgr::run_drag_watcher`.
#[cfg(target_os = "windows")]
pub fn run_display_watcher(app: tauri::AppHandle) {
    if DISPLAY_APP.set(app).is_err() {
        return; // already running
    }
    spawn_display_pump();
}

#[cfg(not(target_os = "windows"))]
pub fn run_display_watcher(_app: tauri::AppHandle) {}

#[cfg(target_os = "windows")]
static DISPLAY_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Spawn the hidden-window + message-pump thread. Registers a window class, creates a HIDDEN
/// top-level window, and pumps messages so its `display_wndproc` receives `WM_DISPLAYCHANGE`.
///
/// NOTE — deliberately NOT a message-only (`HWND_MESSAGE`) window: message-only windows are excluded
/// from the top-level set and do not receive broadcast/system messages like `WM_DISPLAYCHANGE`, so
/// one would never fire. A hidden (never-shown, zero-size, no `WS_VISIBLE`) top-level window IS in the
/// broadcast set and receives it, while staying invisible and out of `EnumWindows`-based pickers (no
/// title → `windowmgr::is_arrangeable` filters it, and it is our own PID anyway).
#[cfg(target_os = "windows")]
fn spawn_display_pump() {
    let _ = std::thread::Builder::new()
        .name("displaywatch".into())
        .spawn(|| unsafe {
            use windows::Win32::System::LibraryLoader::GetModuleHandleW;
            use windows::Win32::UI::WindowsAndMessaging::{
                CreateWindowExW, DispatchMessageW, GetMessageW, MSG, RegisterClassW,
                WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
            };
            use windows::core::w;

            let hinstance = GetModuleHandleW(None).unwrap_or_default();
            let class_name = w!("WidgetsackDisplayWatch");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(display_wndproc),
                hInstance: hinstance.into(),
                lpszClassName: class_name,
                ..Default::default()
            };
            // A zero return means the class couldn't be registered — without it we can't create the
            // window, so there's nothing to pump. Bail (keepalive's 30s path still covers recovery).
            if RegisterClassW(&wc) == 0 {
                return;
            }
            // Hidden top-level window (no WS_VISIBLE, zero-size): it never shows but sits in the
            // top-level set so it receives WM_DISPLAYCHANGE. Parent None (NOT HWND_MESSAGE) — see the
            // fn doc for why message-only won't work here.
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class_name,
                w!("widgetsack display watcher"),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                None,
                None,
                Some(hinstance.into()),
                None,
            );
            if hwnd.is_err() {
                return;
            }
            // Pump: sent messages (WM_DISPLAYCHANGE is delivered as one) are dispatched to the wndproc
            // during GetMessageW; DispatchMessageW covers any posted messages too. Mirrors windowmgr.rs.
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                let _ = DispatchMessageW(&msg);
            }
        });
}

/// Window procedure for the hidden watcher window: on `WM_DISPLAYCHANGE`, kick the debounced
/// zero-window respawn; everything else falls through to the default handler.
#[cfg(target_os = "windows")]
unsafe extern "system" fn display_wndproc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::{DefWindowProcW, WM_DISPLAYCHANGE};
    if msg == WM_DISPLAYCHANGE {
        on_display_change();
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// React to a `WM_DISPLAYCHANGE`: after a short debounce (topology changes fire bursts and the
/// returning monitor takes a beat to enumerate), if the app currently has NO windows respawn a hidden
/// `main` so the overlay reconcile cycle re-runs at once. If any window is live, stand down — its JS
/// handles the refit. Best-effort; duplicate calls while an attempt is pending are no-ops. Mirrors
/// keepalive.rs::on_zero_windows (pending guard + delayed spawn + main-thread window creation).
#[cfg(target_os = "windows")]
fn on_display_change() {
    use tauri::Manager;

    let Some(app) = DISPLAY_APP.get() else {
        return; // not wired yet
    };
    if RESPAWN_PENDING.swap(true, Ordering::SeqCst) {
        return; // an attempt is already scheduled for this burst
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(DEBOUNCE).await;
        let handle = app.clone();
        // Window creation must run on the main thread (same constraint as keepalive/watch_layout).
        let _ = app.run_on_main_thread(move || {
            RESPAWN_PENDING.store(false, Ordering::SeqCst);
            if should_respawn_on_display_change(handle.webview_windows().len()) {
                crate::command::respawn_main_hidden(&handle, "display change");
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::should_respawn_on_display_change;

    #[test]
    fn respawns_only_when_zero_windows() {
        // The whole point: recover the display-change gap ONLY when no window (hence no JS poller)
        // is alive. With any window up, its own JS handles the refit and we must stand down.
        assert!(should_respawn_on_display_change(0));
        assert!(!should_respawn_on_display_change(1));
        assert!(!should_respawn_on_display_change(3));
    }
}
