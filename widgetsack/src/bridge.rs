//! The Rust side of the bridge contract: every Tauri EVENT name the backend emits, as one
//! `pub const`, so emit sites can't silently drift from the frontend listeners.
//! MUST mirror `client/src/lib/bridge/contract.ts` (`EVENTS`) — when a wire string changes,
//! update both files in the same change (AGENTS.md §5/§8).
//!
//! Command names are deliberately NOT centralized here: a `#[tauri::command]`'s wire name is
//! its fn name (the macro owns it); the TS side mirrors those in `COMMANDS`.

/// 1 Hz sensor batches (sensors.rs; ha/mqtt/stocks push onto the same event).
pub const TELEMETRY_EVENT: &str = "telemetry";

/// Streamed LLM tokens (llm.rs → lib/llm/source.ts).
pub const LLM_DELTA_EVENT: &str = "llm_delta";

/// One `LogRecord` to the webview (log.rs → lib/logs.ts).
pub const LOG_EVENT: &str = "log";

/// Media session deltas: `state.rs::updater`'s event kinds, emitted by `event.rs::emit_to_bridge`
/// and consumed by components/NowPlaying/source.ts. (`session_create` is emitted but the client
/// currently only listens to update/delete.)
pub const SESSION_CREATE_EVENT: &str = "session_create";
pub const SESSION_UPDATE_EVENT: &str = "session_update";
pub const SESSION_DELETE_EVENT: &str = "session_delete";

/// Config-file watchers (command.rs): the frontend live-reloads on these.
pub const LAYOUT_CHANGED_EVENT: &str = "layout_changed";
pub const THEMES_CHANGED_EVENT: &str = "themes_changed";
pub const CONTROLS_CHANGED_EVENT: &str = "controls_changed";

/// Tray / global-hotkey broadcasts (main.rs). `toggle_edit` carries the NEW overlay edit state
/// (`bool`, owned by command/windows.rs `OverlayEditState`); both the hotkey and the client's Ctrl+E
/// (`toggle_overlay_edit`) emit it from the backend. (There is no `open_studio` event any more: main.rs `open_or_focus_studio` builds
/// the studio window itself rather than relying on main's JS listener.)
pub const TOGGLE_EDIT_EVENT: &str = "toggle_edit";
pub const ARRANGE_ZONES_EVENT: &str = "arrange_zones";
/// Tray Quit (command/windows.rs `quit_after_flush`): every window flushes pending writes, then
/// acknowledges with `quit_flushed` before the app exits.
pub const APP_QUITTING_EVENT: &str = "app_quitting";
/// Re-fit every overlay to the CURRENT display layout (tray "Re-fit overlays" + the manual trigger).
/// Each overlay/studio listens and re-runs its fit/reconcile — used when monitors are
/// added/removed/moved/resized at runtime, which fires no per-window scale-change event.
pub const REFIT_OVERLAYS_EVENT: &str = "refit_overlays";

/// Foreign-window drag watcher (windowmgr.rs → DragSnapLayer.tsx).
pub const WIN_DRAG_START_EVENT: &str = "win_drag_start";
pub const WIN_DRAG_END_EVENT: &str = "win_drag_end";

pub const MCP_STUDIO_REQUEST: &str = "mcp_studio_request";
