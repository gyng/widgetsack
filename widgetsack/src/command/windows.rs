use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::{bridge, clickthrough, log};
use tauri::{Emitter, Manager};

// --- overlay edit mode (authoritative, app-wide) ------------------------------------------------------
// Every overlay window follows ONE edit state owned here. Broadcasting a bare "toggle" let a window
// created or reloaded mid-edit start passive and then flip opposite to the rest on every later toggle
// (leaving one monitor a whole-window interactive surface). Toggles now flip this flag and broadcast
// the resulting value; a new window reads it at init.

/// The overlays' shared edit-mode flag (managed state).
#[derive(Default)]
pub struct OverlayEditState(AtomicBool);

impl OverlayEditState {
    pub fn get(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// Flip the flag atomically; returns the NEW value (concurrent toggles each see a distinct flip).
    pub fn toggle(&self) -> bool {
        !self.0.fetch_xor(true, Ordering::SeqCst)
    }
}

/// Toggle overlay edit mode and broadcast the resulting state (`toggle_edit`, payload = `bool`).
/// Shared by the global hotkey (main.rs) and the `toggle_overlay_edit` command (Ctrl+E).
pub fn toggle_overlay_edit_and_broadcast<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let edit = app.state::<OverlayEditState>().toggle();
    let _ = app.emit(bridge::TOGGLE_EDIT_EVENT, edit);
    edit
}

/// Toggle overlay edit mode for every window; returns the new state.
#[tauri::command]
pub fn toggle_overlay_edit(app: tauri::AppHandle) -> bool {
    toggle_overlay_edit_and_broadcast(&app)
}

/// The current overlay edit state — read by a window at init so it joins in the right mode.
#[tauri::command]
pub fn get_overlay_edit(state: tauri::State<'_, OverlayEditState>) -> bool {
    state.get()
}

/// Open the webview devtools/inspector for the calling window (CSS development from the studio's
/// context menu). `open_devtools` is available because tauri's `devtools` feature is enabled in
/// Cargo.toml (it is also always available in debug builds).
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

// --- by-label window control (the Diagnostics panel's crash-recovery controls) -----------------------
// These target ANOTHER window by label from the studio, driven entirely by the backend. That matters
// because the per-window JS event bridge (lib/diag.ts) dies with the window's webview — when an overlay
// OOM-crashes, its JS can no longer answer the poll or obey "open devtools / drop click-through", so the
// crashed window vanishes from the list and stays an un-clickable, uninspectable click-through surface.
// Routing these through the backend (the OS window object outlives the renderer) keeps a crashed overlay
// listable, inspectable, and rescuable.

/// Every live app window's label (`studio`, `main`, `overlay-1`, …). The Diagnostics panel uses this as
/// the source of truth for which windows exist, so a window whose webview crashed (and therefore stopped
/// reporting over the JS bridge) still appears — marked "not responding" — instead of silently dropping.
#[tauri::command]
pub fn list_window_labels(app: tauri::AppHandle) -> Vec<String> {
    app.webview_windows().into_keys().collect()
}

/// Open devtools for the window with `label` (not necessarily the caller). Lets the studio inspect a
/// crashed/passive overlay it could never reach through that overlay's own (dead) JS.
#[tauri::command]
pub fn open_devtools_for(app: tauri::AppHandle, label: String) {
    if let Some(win) = app.get_webview_window(&label) {
        win.open_devtools();
    }
}

// --- tray Quit: let every window land its pending writes first -------------------------------------
// `app.exit(0)` alone tears the webviews down before an overlay's debounced preview write (≤150 ms
// old) reaches disk, losing the last edit. Quit now broadcasts `app_quitting`, waits until every
// window acknowledges (`quit_flushed`) — bounded, so a crashed/hung webview can't block the exit —
// and then exits.

/// Upper bound on how long Quit waits for the windows' flush acknowledgements.
const QUIT_FLUSH_TIMEOUT: Duration = Duration::from_millis(1000);

/// The windows still flushing for an in-progress Quit (`None` = no Quit in progress).
#[derive(Default)]
pub struct QuitFlush(Mutex<Option<HashSet<String>>>);

impl QuitFlush {
    /// Start a Quit waiting on `labels`. `false` if a Quit is already in progress.
    fn begin(&self, labels: impl IntoIterator<Item = String>) -> bool {
        let mut pending = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if pending.is_some() {
            return false;
        }
        *pending = Some(labels.into_iter().collect());
        true
    }

    /// `label` finished flushing.
    fn ack(&self, label: &str) {
        if let Some(pending) = self.0.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            pending.remove(label);
        }
    }

    /// Every awaited window has acknowledged — or is gone (`alive` false), since a closed window
    /// will never answer.
    fn settled(&self, alive: impl Fn(&str) -> bool) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_none_or(|pending| pending.iter().all(|label| !alive(label)))
    }
}

/// Tray Quit: ask every window to flush pending writes, wait (≤ [`QUIT_FLUSH_TIMEOUT`]) for their
/// acks, then exit. Never blocks the calling (main) thread — the windows' acks need it. A second Quit
/// while one is waiting exits immediately.
pub fn quit_after_flush<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let labels: Vec<String> = app.webview_windows().into_keys().collect();
    if !app.state::<QuitFlush>().begin(labels) {
        app.exit(0);
        return;
    }
    let _ = app.emit(bridge::APP_QUITTING_EVENT, ());
    let app = app.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + QUIT_FLUSH_TIMEOUT;
        let alive = |label: &str| app.get_webview_window(label).is_some();
        while Instant::now() < deadline && !app.state::<QuitFlush>().settled(alive) {
            std::thread::sleep(Duration::from_millis(20));
        }
        app.exit(0);
    });
}

/// A window finished flushing its pending writes for Quit.
#[tauri::command]
pub fn quit_flushed(window: tauri::WebviewWindow, state: tauri::State<'_, QuitFlush>) {
    state.ack(window.label());
}

/// Toggle whole-window click-through for the window with `label`. `interactive = true` drops
/// click-through (and brings the window forward so you can actually click it — e.g. a crashed overlay's
/// "Reload" page); `false` restores it. No-op if the label is unknown.
#[tauri::command]
pub fn set_window_interactive(
    app: tauri::AppHandle,
    label: String,
    interactive: bool,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        if interactive {
            // Whole-window interactive: drop its per-widget rects FIRST, or the click-through watcher's
            // cached verdict flips click-through back on the next time the cursor crosses a stale rect.
            clickthrough::forget_window(&app.state::<clickthrough::InteractiveRects>(), &label);
        }
        win.set_ignore_cursor_events(!interactive)
            .map_err(|e| e.to_string())?;
        if interactive {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
    Ok(())
}

/// Make EVERY app window interactive again and bring it forward — the backend "panic button" for a
/// window you can't reach: a click-through overlay, or one whose webview crashed so its own JS can no
/// longer drop click-through. Best-effort per window; never panics. Shared by the rescue hotkey
/// (main.rs) and the `rescue_windows` command, so it's generic over the runtime.
pub fn rescue_all<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let rects = app.state::<clickthrough::InteractiveRects>();
    for (label, win) in app.webview_windows() {
        // Forget its per-widget rects first (see set_window_interactive): otherwise the watcher
        // re-enables click-through as soon as the cursor crosses a rect, undoing the rescue.
        clickthrough::forget_window(&rects, &label);
        let _ = win.set_ignore_cursor_events(false);
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Command wrapper for [`rescue_all`] (the studio's "Rescue all windows" button).
#[tauri::command]
pub fn rescue_windows(app: tauri::AppHandle) {
    rescue_all(&app);
}

/// Reload the webview of the window with `label` — respawns its renderer, recovering a crashed overlay
/// (the WebView2 "Out of Memory" page) without relaunching the app. No-op if the label is unknown.
#[tauri::command]
pub fn reload_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        win.reload().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Re-create the primary `main` overlay window (born hidden) after it was torn down to reclaim its
/// renderer (overlay.ts `setMainWindowVisible(false)`). Mirrors the static `main` config in
/// tauri.conf.json; the frontend reveals it — or re-destroys it if the primary is still empty — once
/// its Canvas init runs. Must be called on the main thread (window creation). Best-effort: logs.
/// `reason` tags the log line with which recovery path fired (layout watcher / keepalive).
pub(crate) fn respawn_main_hidden(app: &tauri::AppHandle, reason: &str) {
    match tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("/".into()))
        .title("widgetsack")
        .inner_size(300.0, 400.0)
        .transparent(true)
        .shadow(false)
        .decorations(false)
        .always_on_top(false)
        .always_on_bottom(true)
        .skip_taskbar(true)
        .visible(false)
        .disable_drag_drop_handler()
        // Same WebView2 args as every other window (shared user-data folder) — see mcp::browser_args.
        .additional_browser_args(&crate::mcp::app_browser_args(app))
        .build()
    {
        Ok(_) => {
            crate::keepalive::main_respawned();
            log::info("reclaim", "respawned primary overlay (main)")
                .field("reason", reason)
                .emit()
        }
        Err(err) => log::warn("reclaim", "failed to respawn main")
            .field("error", err)
            .emit(),
    }
}

#[cfg(test)]
mod tests {
    use super::{OverlayEditState, QuitFlush};

    #[test]
    fn quit_settles_once_every_live_window_acked() {
        let quit = QuitFlush::default();
        let live = |_: &str| true;
        assert!(quit.settled(live)); // no Quit in progress
        assert!(quit.begin(["main".to_string(), "overlay-1".to_string()]));
        assert!(!quit.begin(["main".to_string()])); // a second Quit doesn't restart the wait
        assert!(!quit.settled(live));
        quit.ack("main");
        quit.ack("unknown"); // stray acks are harmless
        assert!(!quit.settled(live));
        quit.ack("overlay-1");
        assert!(quit.settled(live));
    }

    #[test]
    fn quit_does_not_wait_on_a_window_that_closed() {
        let quit = QuitFlush::default();
        assert!(quit.begin(["main".to_string(), "overlay-1".to_string()]));
        quit.ack("main");
        assert!(quit.settled(|label| label != "overlay-1"));
    }

    #[test]
    fn overlay_edit_starts_passive_and_toggle_returns_the_new_state() {
        let state = OverlayEditState::default();
        assert!(!state.get());
        assert!(state.toggle());
        assert!(state.get());
        assert!(!state.toggle());
        assert!(!state.get());
    }
}
