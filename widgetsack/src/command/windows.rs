use crate::log;
use tauri::Manager;

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
    for win in app.webview_windows().into_values() {
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
        .build()
    {
        Ok(_) => log::info("reclaim", "respawned primary overlay (main)")
            .field("reason", reason)
            .emit(),
        Err(err) => log::warn("reclaim", "failed to respawn main")
            .field("error", err)
            .emit(),
    }
}
