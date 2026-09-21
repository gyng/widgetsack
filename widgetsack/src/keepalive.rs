//! Zero-window keep-alive.
//!
//! widgetsack is a TRAY app, but Tauri's default is to exit as soon as the last window closes.
//! Zero windows is a valid — and reachable — state here: an empty-primary `main` destroys itself
//! at startup to reclaim its renderer (overlay.ts `setMainWindowVisible`), so on a layout whose
//! only widgets sit on one secondary monitor the whole app hangs on a single overlay window. Any
//! transient failure to create it (monitor not yet enumerated at logon, a WebView2/GPU hiccup,
//! the monitor DDC-switched away) used to end the process silently — the "didn't autostart"
//! failure mode of 2026-07-10. `main.rs` prevents that exit via `should_prevent_exit`; this
//! module then owns the recovery.
//!
//! Recovery: after `RESPAWN_DELAY`, respawn a hidden `main` (command.rs `respawn_main_hidden`).
//! Its own Canvas init re-runs the reconcile cycle — spawning overlays for whatever monitors are
//! present NOW, then self-destroying again if the primary is still empty. If nothing could be
//! spawned the cycle lands back here (the last window closed again), so retries pace themselves
//! at one webview boot per `RESPAWN_DELAY` until a monitor returns — no polling, no hot loop.
//! `RESPAWN_PENDING` keeps it to one in-flight attempt per zero-window episode.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Pause between hitting zero windows and the `main` respawn attempt. Long enough to keep the
/// retry cycle gentle while the failure persists (one short-lived webview boot per interval),
/// short enough that overlays return promptly once the monitor is back.
const RESPAWN_DELAY: Duration = Duration::from_secs(30);

/// One in-flight respawn attempt at a time; reset on the main thread right before the attempt.
static RESPAWN_PENDING: AtomicBool = AtomicBool::new(false);

/// Set by the frontend (`main_reclaimed`) when `main` destroyed itself because there was NOTHING
/// to show anywhere — the primary empty and no populated secondary. Zero windows is then the
/// steady state, not a failure: respawning every 30 s would boot and tear down a ~150 MB renderer
/// forever. The retry is stretched to `RESPAWN_DELAY_EMPTY` instead of skipped, so a zero-window
/// state reached some OTHER way (a renderer crash after the flag was set) still recovers.
static LAYOUT_EMPTY: AtomicBool = AtomicBool::new(false);

/// Retry pace while the layout is known to be empty everywhere.
const RESPAWN_DELAY_EMPTY: Duration = Duration::from_secs(10 * 60);

/// Pure seam: the pause before the next `main` respawn attempt, given what the frontend last
/// reported about the layout.
pub fn respawn_delay(layout_empty: bool) -> Duration {
    if layout_empty {
        RESPAWN_DELAY_EMPTY
    } else {
        RESPAWN_DELAY
    }
}

/// Frontend → backend: `main` is about to destroy itself (renderer reclaim). `populated_elsewhere`
/// says whether any secondary monitor's layout has widgets — i.e. whether other windows will keep
/// the app alive. `false` means the layout is empty everywhere (see `LAYOUT_EMPTY`).
#[tauri::command]
pub fn main_reclaimed(populated_elsewhere: bool) {
    LAYOUT_EMPTY.store(!populated_elsewhere, Ordering::SeqCst);
}

/// Pure seam: whether an `ExitRequested` should be prevented. `code` is `None` when the request
/// came from the last window closing (the state a tray app must survive) and `Some(_)` for an
/// explicit `app.exit(..)` — tray Quit — which must still exit.
pub fn should_prevent_exit(code: Option<i32>) -> bool {
    code.is_none()
}

/// React to a prevented zero-window exit: schedule one delayed respawn of the hidden `main`
/// window so the overlay reconcile cycle gets another chance. Safe to call on every prevented
/// exit — duplicate calls while an attempt is pending are no-ops. Best-effort: if the respawn
/// itself fails to create a window (no window event will re-trigger us), it reschedules itself.
pub fn on_zero_windows(app: &tauri::AppHandle) {
    use tauri::Manager;

    if RESPAWN_PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let delay = respawn_delay(LAYOUT_EMPTY.load(Ordering::SeqCst));
    crate::log::info(
        "keepalive",
        "all windows closed; app kept alive, main respawn scheduled",
    )
    .field("delay_s", delay.as_secs())
    .field(
        "reason",
        if delay == RESPAWN_DELAY_EMPTY {
            "layout empty everywhere (steady state)"
        } else {
            "recovery"
        },
    )
    .emit();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        let handle = app.clone();
        // Window creation must run on the main thread (same constraint as watch_layout's hook).
        let dispatched = app.run_on_main_thread(move || {
            RESPAWN_PENDING.store(false, Ordering::SeqCst);
            // A window may have appeared meanwhile (tray-opened studio, watch_layout respawn,
            // single-instance second launch) — then the reconcile driver is alive; stand down.
            if !handle.webview_windows().is_empty() {
                return;
            }
            crate::command::respawn_main_hidden(&handle, "zero-window keep-alive");
            if handle.webview_windows().is_empty() {
                // Creation itself failed — no window will ever close to re-trigger the cycle,
                // so keep the retry alive by rescheduling directly.
                on_zero_windows(&handle);
            }
        });
        // The pending flag is normally reset INSIDE the closure; if the dispatch itself failed
        // (event loop unavailable — normally only mid-shutdown) the closure never ran, and a
        // stuck `true` would disable keep-alive for the rest of the process. Reset it here.
        if dispatched.is_err() {
            RESPAWN_PENDING.store(false, Ordering::SeqCst);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{RESPAWN_DELAY, RESPAWN_DELAY_EMPTY, respawn_delay, should_prevent_exit};

    #[test]
    fn empty_layout_stretches_the_respawn_pace_instead_of_looping() {
        // Nothing to show anywhere: don't boot a renderer every 30 s forever — but don't give up
        // either (a crash-induced zero-window state must still recover eventually).
        assert_eq!(respawn_delay(true), RESPAWN_DELAY_EMPTY);
        assert_eq!(respawn_delay(false), RESPAWN_DELAY);
        assert!(RESPAWN_DELAY_EMPTY > RESPAWN_DELAY);
    }

    #[test]
    fn last_window_close_is_prevented() {
        // The 2026-07-10 regression: the lone overlay failed to spawn at logon and the app
        // exited silently. `code: None` (last window closed) must be kept alive.
        assert!(should_prevent_exit(None));
    }

    #[test]
    fn explicit_exit_still_exits() {
        // Tray Quit calls app.exit(0); any explicit exit code must pass through.
        assert!(!should_prevent_exit(Some(0)));
        assert!(!should_prevent_exit(Some(1)));
    }
}
