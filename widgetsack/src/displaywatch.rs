//! Display-change watcher: a Rust-side fast path for instant recovery when the monitor topology
//! changes (a display DDC-switched back to this PC, unplugged/replugged, or a resolution change).
//!
//! `keepalive.rs` already respawns a hidden `main` every `RESPAWN_DELAY` (30s) whenever the app is
//! at zero windows, so an overlay that couldn't spawn (monitor not yet enumerated at logon, a
//! WebView2 hiccup, the 4K display switched away) eventually returns. But 30s is a long stare at an
//! empty desktop after flipping a monitor input back. This watcher closes that gap: it listens for
//! `WM_DISPLAYCHANGE` and — when `main` is absent — respawns it immediately, re-running the overlay
//! reconcile cycle the moment a monitor comes back.
//!
//! Studio and secondary overlays do not reconcile missing siblings. A surviving Studio window must
//! not prevent the primary reconcile driver from restarting after a display change.
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

/// Pure seam: the primary `main` window is the only overlay reconciliation driver. Studio and
/// secondaries may survive while an overlay is missing, so their presence does not prevent respawn.
fn should_respawn_on_display_change(labels: &[&str]) -> bool {
    !labels.contains(&"main")
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
            // window, so there's nothing to pump. Bail (keepalive's 30s path still covers recovery),
            // but SAY SO: a silently-dead watcher is indistinguishable from a healthy one.
            if RegisterClassW(&wc) == 0 {
                crate::log::warn(
                    "displaywatch",
                    "RegisterClassW failed; display-change fast path disabled (30s keepalive still covers recovery)",
                )
                .field("error", std::io::Error::last_os_error())
                .emit();
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
            if let Err(err) = hwnd {
                crate::log::warn(
                    "displaywatch",
                    "CreateWindowExW failed; display-change fast path disabled (30s keepalive still covers recovery)",
                )
                .field("error", err)
                .emit();
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
/// returning monitor takes a beat to enumerate), respawn a hidden `main` when it is absent so the
/// overlay reconcile cycle re-runs at once. Best-effort; duplicate calls while an attempt is
/// pending are no-ops. Mirrors keepalive.rs::on_zero_windows (pending guard + delayed spawn +
/// main-thread window creation).
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
        let dispatched = app.run_on_main_thread(move || {
            RESPAWN_PENDING.store(false, Ordering::SeqCst);
            crate::overlay_diag::log_snapshot(&handle, "display change");
            let windows = handle.webview_windows();
            let labels: Vec<&str> = windows.keys().map(String::as_str).collect();
            let respawn = should_respawn_on_display_change(&labels);
            // Always leave a trace: a display change is exactly the moment a hang or a mis-fit
            // happens, and the log file (unlike the webview) survives it.
            crate::log::info("displaywatch", "display change")
                .field("windows", labels.join(", "))
                .field(
                    "action",
                    if respawn {
                        "respawn main"
                    } else {
                        "main already present"
                    },
                )
                .emit();
            if respawn {
                crate::command::respawn_main_hidden(&handle, "display change");
            }
        });
        // Normally reset inside the closure; if the dispatch failed (event loop unavailable —
        // normally only mid-shutdown) a stuck `true` would eat every future display change.
        if dispatched.is_err() {
            RESPAWN_PENDING.store(false, Ordering::SeqCst);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::should_respawn_on_display_change;

    #[test]
    fn respawns_when_the_primary_reconcile_driver_is_missing() {
        // Studio may survive a monitor disconnect while the only populated secondary overlay
        // disappears. Its JS watcher only refreshes Studio's monitor list, so it cannot recreate
        // the missing overlay without a fresh main window to run reconciliation.
        assert!(should_respawn_on_display_change(&[]));
        assert!(should_respawn_on_display_change(&["studio"]));
        assert!(should_respawn_on_display_change(&["overlay-DISPLAY2"]));
        assert!(!should_respawn_on_display_change(&["main", "studio"]));
    }
}
