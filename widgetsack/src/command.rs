use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use notify::Watcher;
use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::bridge::{CONTROLS_CHANGED_EVENT, LAYOUT_CHANGED_EVENT, THEMES_CHANGED_EVENT};
use crate::{AppState, SessionRecord, log};

#[derive(Serialize)]
pub struct UpdateResponse {
    pub sessions: HashMap<usize, SessionRecord>,
}

#[tauri::command]
pub async fn get_initial_sessions(
    _message: String,
    state: tauri::State<'_, AppState>,
    art: tauri::State<'_, crate::art::ArtState>,
) -> Result<UpdateResponse, String> {
    let sessions = state.sessions.lock().await;

    let mut cloned: HashMap<usize, SessionRecord> = HashMap::new();
    cloned.clone_from(&sessions);

    // Re-register each session's cover so the URLs in this snapshot resolve for a just-booted
    // overlay even if the live media events fired before its webview existed (art.rs).
    for record in cloned.values() {
        crate::art::note_record(&art, record);
    }

    Ok(UpdateResponse { sessions: cloned })
}

/// The app config dir — isolated into a `multi/` subfolder for an extra dev instance
/// (`crate::multi_instance`), so a dev build run alongside the installed release never reads or writes
/// the release's widgets.json / themes / layouts / sacks. The real config dir otherwise. All the
/// config/theme/layout/sack/wallpaper/plugin paths (and their file watchers) go through this.
fn config_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(if crate::multi_instance() {
        base.join("multi")
    } else {
        base
    })
}

/// Path to the persisted widget layout (`widgets.json` in the app config dir).
fn layout_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = config_root(app)?;
    Ok(dir.join("widgets.json"))
}

/// Read the saved layout file, or `None` if it does not exist yet. The frontend
/// validates/parses the contents (see core/layout.ts) so this stays dumb I/O.
#[tauri::command]
pub async fn load_layout(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = layout_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

/// Write the layout file, creating the config directory if needed.
#[tauri::command]
pub async fn save_layout(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    let path = layout_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Filename prefix for layout backups taken on parse failure (`widgets.json.bad-<epoch-ms>`).
const LAYOUT_BACKUP_PREFIX: &str = "widgets.json.bad-";
/// How many parse-failure backups to keep (oldest pruned).
const LAYOUT_BACKUPS_KEPT: usize = 3;

/// Pure seam: which backup FILENAMES to delete so only the newest `keep` remain. The epoch-ms
/// suffix is fixed-width for any realistic date, so a plain descending lexicographic sort is
/// newest-first. Tested below.
fn stale_backups(mut names: Vec<String>, keep: usize) -> Vec<String> {
    names.sort_by(|a, b| b.cmp(a));
    names.split_off(keep.min(names.len()))
}

/// Copy the CURRENT widgets.json aside as `widgets.json.bad-<epoch-ms>` — called by the frontend
/// when it fails to PARSE the layout, BEFORE the running app (now on an in-memory default) can
/// save over the original and destroy whatever was hand-recoverable in it. Keeps the newest
/// `LAYOUT_BACKUPS_KEPT` backups, pruning older ones. Returns the backup path, or `None` when
/// there is no layout file to back up. Best-effort by design: the caller logs, never blocks on it.
#[tauri::command]
pub async fn backup_layout(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = layout_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let dir = path
        .parent()
        .ok_or_else(|| "layout path has no parent".to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let backup = dir.join(format!("{LAYOUT_BACKUP_PREFIX}{ts}"));
    fs::copy(&path, &backup).map_err(|e| e.to_string())?;
    // Prune older backups (best-effort — a leftover extra backup is harmless).
    if let Ok(entries) = fs::read_dir(dir) {
        let names: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.starts_with(LAYOUT_BACKUP_PREFIX))
            .collect();
        for stale in stale_backups(names, LAYOUT_BACKUPS_KEPT) {
            let _ = fs::remove_file(dir.join(stale));
        }
    }
    log::warn(
        "layout",
        "layout failed to parse; backed up before any overwrite",
    )
    .field("backup", backup.display())
    .emit();
    Ok(Some(backup.display().to_string()))
}

/// Path to the persisted control remaps (`controls.json` in the app config dir).
fn controls_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = config_root(app)?;
    Ok(dir.join("controls.json"))
}

/// Read the saved control overrides, or `None` if none saved yet. The frontend validates/parses
/// the contents (core/controls.ts `parseControlOverrides`) so this stays dumb I/O — mirrors
/// `load_layout`, and an absent/garbage file simply falls back to the code defaults.
#[tauri::command]
pub async fn load_controls(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = controls_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

/// Write the control overrides file, creating the config directory if needed.
#[tauri::command]
pub async fn save_controls(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    let path = controls_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, contents).map_err(|e| e.to_string())
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

/// Append a window's diagnostics summary to the rotating log file (the memory TRAIL). Each window calls
/// this on an interval (lib/diag.ts `startMemoryTrail`); because it lands on disk, the run-up to an
/// unattended overnight OOM survives the crash — read the last `memtrail` lines to see which metric was
/// climbing. Logged at info so it persists in release builds; the window label is attached as a field.
#[tauri::command]
pub fn log_diag(window: tauri::WebviewWindow, summary: String) {
    log::info("memtrail", summary)
        .field("window", window.label())
        .emit();
}

/// Map a frontend log level string to a backend [`log::LogLevel`]. Only "error" and "warn" are
/// distinguished; anything else (incl. "info", "log", "", or a typo) falls back to `Info` — a
/// client log is worth keeping even if its severity label is off. Pure seam (tested below).
fn client_log_level(level: &str) -> log::LogLevel {
    match level {
        "error" => log::LogLevel::Error,
        "warn" => log::LogLevel::Warn,
        _ => log::LogLevel::Info,
    }
}

/// Cap a client-supplied string at `max` CHARS (not bytes — never splits a UTF-8 scalar), marking
/// the cut with a trailing `…`. The webview side of `log_client` is app code, but a buggy render
/// loop stringifying a huge object into `message` would otherwise churn straight through the log's
/// 1 MiB rotation. Pure seam (tested below).
fn truncate_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// Caps for `log_client` fields: generous for a diagnostic line, tiny next to the 1 MiB rotation.
const CLIENT_LOG_MESSAGE_MAX: usize = 4096;
const CLIENT_LOG_COMPONENT_MAX: usize = 64;

/// Persist a FRONTEND failure into the backend log pipeline (console + ring buffer + rotating file +
/// `log` event). Frontend errors — an overlay reconcile that threw, a failed invoke — otherwise live
/// only in the webview's console and VANISH when that webview dies, which is exactly the class of
/// failure that's hardest to diagnose after the fact (the overnight forensics of 2026-07-10). This
/// lands them on disk. `level` picks the severity (see `client_log_level`); the `component` and the
/// calling `window`'s label are attached as fields. Target is the fixed "client" subsystem (the log
/// builders take a `&'static str` target, so the dynamic part goes in a field). Mirrors `log_diag`.
#[tauri::command]
pub fn log_client(window: tauri::WebviewWindow, level: String, component: String, message: String) {
    let message = truncate_chars(&message, CLIENT_LOG_MESSAGE_MAX);
    let entry = match client_log_level(&level) {
        log::LogLevel::Error => log::error("client", message),
        log::LogLevel::Warn => log::warn("client", message),
        _ => log::info("client", message),
    };
    entry
        .field(
            "component",
            truncate_chars(&component, CLIENT_LOG_COMPONENT_MAX),
        )
        .field("window", window.label())
        .emit();
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFont {
    /// Family name (CSS `font-family`).
    pub name: String,
    /// PostScript name (often a spaceless variant of the family).
    pub font_name: String,
    /// Absolute path to the font file (for the webview to @font-face via the asset protocol).
    pub path: String,
}

/// Enumerate installed fonts (incl. PER-USER ones) with their file paths. Chromium's sandboxed
/// webview won't render a per-user-installed font by name — but fontdb can find it here, and the
/// frontend then loads the file directly via @font-face + the asset protocol (the approach of
/// tauri-plugin-system-fonts, inlined). The per-user fonts dir is added explicitly (where Windows
/// puts "install for me only" fonts).
#[tauri::command]
pub fn system_fonts() -> Vec<SystemFont> {
    use fontdb::{Database, Source};
    let mut db = Database::new();
    db.load_system_fonts();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        db.load_fonts_dir(std::path::Path::new(&local).join("Microsoft\\Windows\\Fonts"));
    }
    db.faces()
        .filter_map(|f| match &f.source {
            Source::File(path) => {
                let name = f.families.first()?.0.clone();
                if name.starts_with('.') {
                    return None; // hidden/system aliases
                }
                Some(SystemFont {
                    name,
                    font_name: f.post_script_name.clone(),
                    path: path.to_string_lossy().into_owned(),
                })
            }
            _ => None,
        })
        .collect()
}

// ---- themes (Phase 7c): a `themes/<name>.css` plugin folder in the app config dir ----

fn themes_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = config_root(app)?;
    Ok(dir.join("themes"))
}

/// Write `contents` to `path` atomically: write a sibling temp file, then rename it onto the target
/// (a rename is atomic on the same volume), so a concurrent reader — or a crash mid-write — never
/// sees a truncated/partial file. The temp name keeps the original and appends `.tmp`, so its
/// extension is `tmp` (not `css`/`json`) and the directory watchers, which filter by extension,
/// ignore it. Best-effort cleanup of the temp file on failure.
fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "write path has no file name".to_string())?;
    let mut tmp = path.to_path_buf();
    tmp.set_file_name(format!("{file_name}.tmp"));
    if let Err(err) = fs::write(&tmp, contents) {
        let _ = fs::remove_file(&tmp);
        return Err(err.to_string());
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// The theme names (file stems of `themes/*.css`), sorted. The frontend adds a synthetic
/// "(default)" option (no theme = the meters' token fallbacks).
#[tauri::command]
pub fn list_themes(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = themes_dir(&app)?;
    let mut names = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|x| x.to_str()) == Some("css")
                && let Some(stem) = path.file_stem().and_then(|s| s.to_str())
            {
                names.push(stem.to_string());
            }
        }
    }
    names.sort();
    Ok(names)
}

/// The CSS of theme `name` (a bare file stem), or `None` if it doesn't exist.
#[tauri::command]
pub fn load_theme(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    if !valid_name(&name) {
        return Err("invalid theme name".to_string());
    }
    let path = themes_dir(&app)?.join(format!("{name}.css"));
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

/// Write theme `name` (used by the studio's theme editor + token panel, Phase 7d). Creates
/// `themes/`. Atomic (temp + rename) so a concurrent overlay reload never reads a half-written file.
#[tauri::command]
pub fn save_theme(app: tauri::AppHandle, name: String, contents: String) -> Result<(), String> {
    if !valid_name(&name) {
        return Err("invalid theme name".to_string());
    }
    let dir = themes_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    atomic_write(&dir.join(format!("{name}.css")), &contents)
}

/// Delete theme `name` → removes `themes/<name>.css`. Ok even if it's already gone (idempotent),
/// mirroring `delete_layout`. The themes watcher then emits `themes_changed` so the picker refreshes.
#[tauri::command]
pub fn delete_theme(app: tauri::AppHandle, name: String) -> Result<(), String> {
    if !valid_name(&name) {
        return Err("invalid theme name".to_string());
    }
    let path = themes_dir(&app)?.join(format!("{name}.css"));
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

// ---- wallpapers: media for the per-monitor full-screen background layer ----
// Same "dumb I/O to a fixed folder, no native picker" pattern as themes/sacks: the user drops image
// or video files into `<app config>/wallpapers/` (already inside the asset-protocol scope, so the
// webview can load them), and the studio lists them for the Background section. `BackgroundSpec.src`
// stores the bare filename; the frontend resolves it to an asset URL via `wallpaper_path`.

fn wallpapers_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = config_root(app)?;
    Ok(dir.join("wallpapers"))
}

// Image/video extensions the webview can render (the picker shows only these).
const WALLPAPER_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "mp4", "webm", "mkv", "mov", "m4v",
];

/// A wallpaper filename is a single path component with a media extension. Rejects separators / `..`
/// (path traversal) but — unlike `valid_name` — ALLOWS the extension dot.
fn valid_wallpaper_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && std::path::Path::new(name)
            .extension()
            .and_then(|x| x.to_str())
            .map(|e| WALLPAPER_EXTS.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false)
}

/// The media filenames in `wallpapers/` (image + video only), sorted. Creates the folder so the
/// studio's "open folder" button always has somewhere to point.
#[tauri::command]
pub fn list_wallpapers(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = wallpapers_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str()
                && valid_wallpaper_name(name)
            {
                names.push(name.to_string());
            }
        }
    }
    names.sort();
    Ok(names)
}

/// The absolute path of wallpaper `name`, for the frontend to feed `convertFileSrc`. Validates the
/// name (no traversal); returns the path even if the file is missing (the <img>/<video> just won't
/// load), so the caller doesn't have to special-case a not-yet-present file.
#[tauri::command]
pub fn wallpaper_path(app: tauri::AppHandle, name: String) -> Result<String, String> {
    if !valid_wallpaper_name(&name) {
        return Err("invalid wallpaper name".to_string());
    }
    Ok(wallpapers_dir(&app)?
        .join(name)
        .to_string_lossy()
        .into_owned())
}

/// Open the `wallpapers/` folder in Explorer so the user can drop media in. Creates it first.
#[tauri::command]
pub fn open_wallpapers_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = wallpapers_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- sacks: shareable bundles (`sacks/<name>.sack.json` in the app config dir) ----
// A "sack" packs the widget library + active theme CSS + token overrides as one JSON file so a
// user can share/reuse a set. Dumb I/O to a fixed folder (no native file picker); the frontend
// owns the format + merge logic (core/sack.ts).

fn sacks_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = config_root(app)?;
    Ok(dir.join("sacks"))
}

/// Shared filename allowlist for user-named config files (themes, sacks). The name becomes a
/// path segment, so it must be a safe, bounded token: 1–64 chars of `[A-Za-z0-9 _-]` only. This
/// rejects control chars, path separators, `..`, and Windows-reserved characters by construction;
/// the explicit empty/`..`/separator checks below are kept as a defensive backstop. Leading/trailing
/// spaces are rejected too — Windows silently trims trailing spaces/dots from filenames, so `"a "`
/// and `"a"` would collide on disk and a delete-by-name could miss.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name == name.trim()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '-')
}

fn valid_sack_name(name: &str) -> bool {
    valid_name(name)
}

/// The sack names (file stems of `sacks/*.sack.json`), sorted.
#[tauri::command]
pub fn list_sacks(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = sacks_dir(&app)?;
    let mut names = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(file) = path.file_name().and_then(|s| s.to_str())
                && let Some(stem) = file.strip_suffix(".sack.json")
            {
                names.push(stem.to_string());
            }
        }
    }
    names.sort();
    Ok(names)
}

/// The JSON of sack `name`, or `None` if it doesn't exist. The frontend parses/validates it.
#[tauri::command]
pub fn read_sack(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    if !valid_sack_name(&name) {
        return Err("invalid sack name".to_string());
    }
    let path = sacks_dir(&app)?.join(format!("{name}.sack.json"));
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

/// Write sack `name` (creates `sacks/`). Returns the absolute path written, for the UI to show.
#[tauri::command]
pub fn write_sack(app: tauri::AppHandle, name: String, contents: String) -> Result<String, String> {
    if !valid_sack_name(&name) {
        return Err("invalid sack name".to_string());
    }
    let dir = sacks_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}.sack.json"));
    fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// ---- saved layouts: named layout profiles (`layouts/<name>.layout.json` in the app config dir) ----
// A saved layout is one monitor's arrangement (root tree + floating widgets) the user can name, list,
// load back, and delete from the studio. Dumb I/O to a fixed folder (same shape as sacks/themes); the
// frontend owns the JSON format + the load/replace logic (core/savedLayout.ts).

fn layouts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = config_root(app)?;
    Ok(dir.join("layouts"))
}

/// The saved-layout names (file stems of `layouts/*.layout.json`), sorted.
#[tauri::command]
pub fn list_layouts(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = layouts_dir(&app)?;
    let mut names = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(file) = path.file_name().and_then(|s| s.to_str())
                && let Some(stem) = file.strip_suffix(".layout.json")
            {
                names.push(stem.to_string());
            }
        }
    }
    names.sort();
    Ok(names)
}

/// The JSON of saved layout `name`, or `None` if it doesn't exist. The frontend parses/validates it.
#[tauri::command]
pub fn read_layout(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    if !valid_name(&name) {
        return Err("invalid layout name".to_string());
    }
    let path = layouts_dir(&app)?.join(format!("{name}.layout.json"));
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

/// Write saved layout `name` (creates `layouts/`). Returns the absolute path written.
#[tauri::command]
pub fn save_layout_as(
    app: tauri::AppHandle,
    name: String,
    contents: String,
) -> Result<String, String> {
    if !valid_name(&name) {
        return Err("invalid layout name".to_string());
    }
    let dir = layouts_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}.layout.json"));
    fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Delete saved layout `name`. Ok even if it's already gone (idempotent).
#[tauri::command]
pub fn delete_layout(app: tauri::AppHandle, name: String) -> Result<(), String> {
    if !valid_name(&name) {
        return Err("invalid layout name".to_string());
    }
    let path = layouts_dir(&app)?.join(format!("{name}.layout.json"));
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

// ---- plugin packages: declarative third-party bundles (`plugins/<id>/plugin.json`) ----
// The app-config `plugins/` dir already holds first-party config FILES (ha.json, llm.json, …);
// a third-party package is a SUBDIRECTORY containing a `plugin.json`, so the two coexist
// unambiguously — only directories with a manifest are listed. Dumb I/O only: the frontend
// parses/validates the manifest (core/pluginPackage.ts) and decides what to register.

fn plugins_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = config_root(app)?;
    Ok(dir.join("plugins"))
}

/// A package asset filename is a single path component: `<valid_name stem>.<css|json|js>` (`.js`
/// is a Phase 2 sandboxed source script — it is only ever TEXT to the backend). Splitting at the
/// LAST dot and running the stem through `valid_name` rejects separators, `..`, extra dots
/// (so no `x.css.tmp` smuggling), and oversized names by construction.
fn valid_asset_name(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((stem, ext)) => {
            (ext.eq_ignore_ascii_case("css")
                || ext.eq_ignore_ascii_case("json")
                || ext.eq_ignore_ascii_case("js"))
                && valid_name(stem)
        }
        None => false,
    }
}

#[derive(Serialize)]
pub struct PluginPackageFile {
    /// The package directory name (its id; the frontend cross-checks the manifest's `id`).
    pub id: String,
    /// Raw `plugin.json` contents, unparsed.
    pub manifest: String,
    /// Raw `.install.json` sidecar (written by `install_plugin_package`), unparsed — the frontend
    /// parses it (core/pluginPackage.ts `parseInstallSidecar`) to show provenance and drive the
    /// update-check/update affordances. `None` for hand-dropped (local) packages.
    pub install: Option<String>,
}

/// Every `plugins/<id>/plugin.json`, sorted by id. Directories only (first-party config FILES in
/// `plugins/` are skipped), ids must pass `valid_name` (they become path segments in
/// `read_plugin_package_asset`). Missing `plugins/` dir → empty vec.
#[tauri::command]
pub fn list_plugin_packages(app: tauri::AppHandle) -> Result<Vec<PluginPackageFile>, String> {
    let dir = plugins_dir(&app)?;
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(id) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !valid_name(id) {
                continue;
            }
            if let Ok(manifest) = fs::read_to_string(path.join("plugin.json")) {
                out.push(PluginPackageFile {
                    id: id.to_string(),
                    manifest,
                    install: fs::read_to_string(path.join(INSTALL_SIDECAR)).ok(),
                });
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Read `plugins/<id>/<name>` — a manifest-declared asset (theme CSS / extra JSON). Both segments
/// are sanitized (no traversal); only `.css`/`.json` files are readable. `None` if absent.
#[tauri::command]
pub fn read_plugin_package_asset(
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<Option<String>, String> {
    if !valid_name(&id) {
        return Err("invalid package id".to_string());
    }
    if !valid_asset_name(&name) {
        return Err("invalid asset name".to_string());
    }
    let path = plugins_dir(&app)?.join(&id).join(&name);
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

// ---- plugin packages: remote install (Phase 3) -------------------------------------------------
// Install a package straight from a GitHub link (or any https URL to a plugin.json): fetch the
// manifest + its declared assets over https (10s timeout, 256 KiB per-file cap), write them into
// `plugins/<id>/` via atomic_write, and record provenance in a `.install.json` sidecar so the
// frontend can offer MANUAL update checks later. Validation stays split exactly like Phase 1: the
// backend only enforces the path-safety invariants (`valid_name` id, `valid_asset_name` assets);
// the frontend does the full structural validation and the enable/consent gate — a freshly
// installed package lands DISABLED like a hand-dropped folder.

/// Provenance sidecar filename. Starts with a dot so its stem fails `valid_name`, which keeps it
/// out of `read_plugin_package_asset`'s reachable set and out of any manifest's declarable assets.
const INSTALL_SIDECAR: &str = ".install.json";

/// Per-file download cap (manifest and each asset) — a plugin.json is a few KiB, a theme CSS tens.
const FETCH_CAP: usize = 256 * 1024;

/// A resolved install source: where the manifest lives, plus what the sidecar should record.
#[derive(Debug, PartialEq)]
struct ResolvedSource {
    /// Direct https URL of the `plugin.json` to GET.
    manifest_url: String,
    /// What the sidecar stores as `source`: `owner/repo` for GitHub forms, the URL itself for
    /// direct links. Paired with `reff`, it's enough to re-derive `manifest_url` at update time.
    display_source: String,
    /// Git ref for GitHub forms (`main` unless a `/tree/<ref>` URL pinned one); `direct` for a
    /// verbatim plugin.json URL.
    reff: String,
}

/// One GitHub owner/repo path segment: ASCII alphanumeric plus `-`/`_`/`.`, no `..`, bounded.
fn gh_token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && !s.contains("..")
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// A git ref as it may appear in a `/tree/<ref>` URL: like `gh_token` but slashes are allowed
/// (branch names such as `feature/x`), `..` still rejected.
fn valid_ref(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && !s.contains("..")
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '/')
}

fn raw_manifest_url(owner: &str, repo: &str, reff: &str) -> String {
    format!("https://raw.githubusercontent.com/{owner}/{repo}/{reff}/plugin.json")
}

/// PURE SEAM: turn the user's install input into a manifest URL + sidecar provenance. Accepted
/// forms (anything else → `None`; plain `http://` is rejected outright — https only):
///
/// | input                                        | manifest_url                                              | ref      |
/// |----------------------------------------------|-----------------------------------------------------------|----------|
/// | `owner/repo`                                 | `https://raw.githubusercontent.com/owner/repo/main/plugin.json`  | `main`   |
/// | `https://github.com/owner/repo[/]`           | same as above                                             | `main`   |
/// | `https://github.com/owner/repo/tree/<ref>`   | `…/owner/repo/<ref>/plugin.json`                          | `<ref>`  |
/// | any https URL ending in `/plugin.json`       | used verbatim                                             | `direct` |
fn resolve_package_source(input: &str) -> Option<ResolvedSource> {
    let input = input.trim().trim_end_matches('/');
    if let Some(rest) = input.strip_prefix("https://") {
        if let Some(path) = rest.strip_prefix("github.com/") {
            // splitn(4): segment 4 keeps any remaining slashes — that's the (slash-friendly) ref.
            let parts: Vec<&str> = path.splitn(4, '/').collect();
            return match parts.as_slice() {
                [owner, repo] if gh_token(owner) && gh_token(repo) => Some(ResolvedSource {
                    manifest_url: raw_manifest_url(owner, repo, "main"),
                    display_source: format!("{owner}/{repo}"),
                    reff: "main".to_string(),
                }),
                [owner, repo, "tree", reff]
                    if gh_token(owner) && gh_token(repo) && valid_ref(reff) =>
                {
                    Some(ResolvedSource {
                        manifest_url: raw_manifest_url(owner, repo, reff),
                        display_source: format!("{owner}/{repo}"),
                        reff: reff.to_string(),
                    })
                }
                _ => None,
            };
        }
        if input.ends_with("/plugin.json") {
            return Some(ResolvedSource {
                manifest_url: input.to_string(),
                display_source: input.to_string(),
                reff: "direct".to_string(),
            });
        }
        return None;
    }
    // `owner/repo` shorthand — exactly one slash, both segments GitHub-safe, no scheme at all.
    if input.contains("://") {
        return None;
    }
    let (owner, repo) = input.split_once('/')?;
    if gh_token(owner) && gh_token(repo) && !repo.contains('/') {
        return Some(ResolvedSource {
            manifest_url: raw_manifest_url(owner, repo, "main"),
            display_source: format!("{owner}/{repo}"),
            reff: "main".to_string(),
        });
    }
    None
}

/// PURE SEAM: a declared asset lives next to its manifest — swap the URL's last segment.
fn asset_url_for(manifest_url: &str, asset_name: &str) -> String {
    match manifest_url.rsplit_once('/') {
        Some((base, _)) => format!("{base}/{asset_name}"),
        None => asset_name.to_string(),
    }
}

/// PURE SEAM: re-derive the manifest URL from sidecar provenance (`source` + `ref`) for update
/// checks / re-installs. `direct` sources re-run through `resolve_package_source` so a tampered
/// sidecar can't smuggle a non-https or non-plugin.json URL back in.
fn manifest_url_from_sidecar(source: &str, reff: &str) -> Option<String> {
    if reff == "direct" {
        let resolved = resolve_package_source(source)?;
        return (resolved.reff == "direct").then_some(resolved.manifest_url);
    }
    let (owner, repo) = source.split_once('/')?;
    if gh_token(owner) && gh_token(repo) && !repo.contains('/') && valid_ref(reff) {
        Some(raw_manifest_url(owner, repo, reff))
    } else {
        None
    }
}

/// A 10s-timeout https client for the (small) manifest/asset fetches.
fn install_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

/// GET `url` and return its body as text, enforcing `FETCH_CAP` while streaming (a hostile or
/// misconfigured server can't make us buffer an unbounded body).
async fn fetch_text_capped(client: &reqwest::Client, url: &str) -> Result<String, String> {
    use futures_util::StreamExt;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("GET {url} failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GET {url} failed: HTTP {}", resp.status()));
    }
    if let Some(len) = resp.content_length()
        && len > FETCH_CAP as u64
    {
        return Err(format!("{url} is too large ({len} bytes; cap {FETCH_CAP})"));
    }
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("GET {url} failed mid-body: {e}"))?;
        if buf.len() + bytes.len() > FETCH_CAP {
            return Err(format!("{url} exceeded the {FETCH_CAP}-byte download cap"));
        }
        buf.extend_from_slice(&bytes);
    }
    String::from_utf8(buf).map_err(|_| format!("{url} is not valid UTF-8"))
}

/// GitHub releases API for the app's own repo — the manual "check for updates" source (the app
/// ships no auto-updater, so this just tells the user a newer release exists).
const GITHUB_LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/gyng/widgetsack/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/gyng/widgetsack/releases";

#[derive(Serialize)]
pub struct AppUpdate {
    pub current: String,
    pub latest: String,
    pub url: String,
    pub update_available: bool,
}

/// Parse an `X.Y.Z` version into a comparable tuple, tolerating a leading `v` and a `-pre`/`+build`
/// suffix; any missing or non-numeric part is 0 so a malformed tag never falsely reports an update.
fn parse_version(v: &str) -> (u32, u32, u32) {
    let core = v.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next().unwrap_or(core);
    let mut parts = core.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

/// Whether `latest` is a newer version than `current` (numeric X.Y.Z compare). Pure seam.
fn version_is_newer(latest: &str, current: &str) -> bool {
    parse_version(latest) > parse_version(current)
}

/// Ask GitHub for the latest published release of the app and compare it to the running version.
/// Manual (driven by the About panel button); best-effort — any network/parse failure is returned
/// as an `Err` the UI shows verbatim. The GitHub REST API requires a User-Agent.
#[tauri::command]
pub async fn check_app_update(app: tauri::AppHandle) -> Result<AppUpdate, String> {
    let current = app.package_info().version.to_string();
    let client = install_http_client()?;
    let resp = client
        .get(GITHUB_LATEST_RELEASE_API)
        .header(reqwest::header::USER_AGENT, "widgetsack")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("update check failed: HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;
    let latest = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or("update check failed: no tag_name in latest release")?
        .trim_start_matches('v')
        .to_string();
    let url = json
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or(RELEASES_PAGE)
        .to_string();
    let update_available = version_is_newer(&latest, &current);
    Ok(AppUpdate {
        current,
        latest,
        url,
        update_available,
    })
}

#[derive(Serialize)]
pub struct InstalledPackage {
    pub id: String,
    pub version: String,
}

/// Install (or re-install — that IS the update path) a package from `source` (see
/// `resolve_package_source` for the accepted forms). Fetches the manifest, minimally reads
/// `id`/`version`/`theme.file` (full validation stays in the frontend), fetches every declared
/// asset, and only THEN writes — a failed download never leaves a half-installed directory.
#[tauri::command]
pub async fn install_plugin_package(
    app: tauri::AppHandle,
    source: String,
) -> Result<InstalledPackage, String> {
    let resolved = resolve_package_source(&source).ok_or_else(|| {
        "unrecognized source — use owner/repo, a github.com repo URL, or an https URL ending in /plugin.json"
            .to_string()
    })?;
    let client = install_http_client()?;
    let manifest_text = fetch_text_capped(&client, &resolved.manifest_url).await?;
    let json: serde_json::Value = serde_json::from_str(&manifest_text)
        .map_err(|_| "downloaded plugin.json is not valid JSON".to_string())?;
    let id = json
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if !valid_name(&id) {
        return Err("manifest \"id\" is missing or not a safe folder name".to_string());
    }
    let version = json
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if version.is_empty() {
        return Err("manifest has no \"version\"".to_string());
    }
    // Declared assets: `theme.file` (Phase 1) and `source.file` (Phase 2 sandbox script) are the
    // only asset slots in manifestVersion 1. Fetch before writing anything.
    let mut assets: Vec<(String, String)> = Vec::new();
    for pointer in ["/theme/file", "/source/file"] {
        if let Some(file) = json.pointer(pointer).and_then(|v| v.as_str()) {
            if !valid_asset_name(file) {
                return Err(format!("declared asset \"{file}\" has an unsafe filename"));
            }
            let body =
                fetch_text_capped(&client, &asset_url_for(&resolved.manifest_url, file)).await?;
            assets.push((file.to_string(), body));
        }
    }
    let dir = plugins_dir(&app)?.join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    atomic_write(&dir.join("plugin.json"), &manifest_text)?;
    for (name, body) in &assets {
        atomic_write(&dir.join(name), body)?;
    }
    let installed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let sidecar = serde_json::json!({
        "source": resolved.display_source,
        "ref": resolved.reff,
        "version": version,
        "installedAt": installed_at,
    });
    atomic_write(&dir.join(INSTALL_SIDECAR), &sidecar.to_string())?;
    Ok(InstalledPackage { id, version })
}

#[derive(Serialize)]
pub struct UpdateCheck {
    pub current: String,
    pub latest: String,
    pub source: String,
}

/// MANUAL update check for an installed package: re-fetch just the manifest from the sidecar's
/// recorded source and report both versions (the frontend compares — any difference counts as
/// "update available"; downgrades are deliberate re-installs). Packages without a sidecar
/// (hand-dropped folders) have nowhere to check against.
#[tauri::command]
pub async fn check_plugin_package_update(
    app: tauri::AppHandle,
    id: String,
) -> Result<UpdateCheck, String> {
    if !valid_name(&id) {
        return Err("invalid package id".to_string());
    }
    let raw = fs::read_to_string(plugins_dir(&app)?.join(&id).join(INSTALL_SIDECAR))
        .map_err(|_| "package was not installed from a URL".to_string())?;
    let side: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "install record is corrupt".to_string())?;
    let source = side
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let reff = side.get("ref").and_then(|v| v.as_str()).unwrap_or("main");
    let current = side
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let url = manifest_url_from_sidecar(&source, reff)
        .ok_or_else(|| "install record has an invalid source".to_string())?;
    let client = install_http_client()?;
    let manifest_text = fetch_text_capped(&client, &url).await?;
    let json: serde_json::Value = serde_json::from_str(&manifest_text)
        .map_err(|_| "remote plugin.json is not valid JSON".to_string())?;
    let latest = json
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if latest.is_empty() {
        return Err("remote manifest has no \"version\"".to_string());
    }
    Ok(UpdateCheck {
        current,
        latest,
        source,
    })
}

/// Delete `plugins/<id>/` (works for installed AND hand-dropped packages — it's just a dir
/// delete). Ok even if it's already gone (idempotent, like the other deletes here).
#[tauri::command]
pub fn remove_plugin_package(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !valid_name(&id) {
        return Err("invalid package id".to_string());
    }
    match fs::remove_dir_all(plugins_dir(&app)?.join(&id)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

// ---- plugin packages: sandboxed source network proxy (Phase 2) ----------------------------------
// A package's `source.js` runs in a QuickJS sandbox with ZERO capabilities; the frontend asks this
// command to perform each fetch between the sandbox's two pure calls. The hosts allowlist is
// re-read from the manifest ON DISK per request (server-side enforcement — a compromised webview
// can't widen it), https only, GET only, redirects DISABLED (so the response host can never drift
// off-allowlist), 10s timeout, 256 KiB body cap.

/// PURE SEAM: is `url` an https URL whose host is a DOMAIN matching one of `hosts` exactly?
/// Subdomains must be listed explicitly; IP literals, explicit ports, embedded credentials, and
/// non-https schemes all fail. Comparison is ASCII-case-insensitive (URL hosts parse lowercased,
/// but the manifest on disk is untrusted text).
fn host_allowed(url: &str, hosts: &[String]) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else {
        return false;
    };
    if u.scheme() != "https" || u.port().is_some() {
        return false;
    }
    if !u.username().is_empty() || u.password().is_some() {
        return false;
    }
    match u.domain() {
        Some(d) => hosts.iter().any(|h| h.eq_ignore_ascii_case(d)),
        None => false, // IP literal (or no host at all)
    }
}

#[derive(Serialize)]
pub struct PackageFetchResponse {
    pub url: String,
    pub status: u16,
    pub body: String,
}

/// GET `url` on behalf of package `id`'s sandboxed source. Non-2xx responses are returned (with
/// their status) rather than erroring — the sandbox's `transform` decides what a miss means; only
/// transport/validation failures are `Err`.
#[tauri::command]
pub async fn package_fetch(
    app: tauri::AppHandle,
    id: String,
    url: String,
) -> Result<PackageFetchResponse, String> {
    if !valid_name(&id) {
        return Err("invalid package id".to_string());
    }
    let raw = fs::read_to_string(plugins_dir(&app)?.join(&id).join("plugin.json"))
        .map_err(|_| "package manifest not found".to_string())?;
    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "package manifest is not valid JSON".to_string())?;
    let hosts: Vec<String> = json
        .pointer("/source/hosts")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if hosts.is_empty() {
        return Err("package declares no source hosts".to_string());
    }
    if !host_allowed(&url, &hosts) {
        return Err(format!("url is not in the package's host allowlist: {url}"));
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GET {url} failed: {e}"))?;
    let status = resp.status().as_u16();
    if let Some(len) = resp.content_length()
        && len > FETCH_CAP as u64
    {
        return Err(format!("{url} is too large ({len} bytes; cap {FETCH_CAP})"));
    }
    use futures_util::StreamExt;
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("GET {url} failed mid-body: {e}"))?;
        if buf.len() + bytes.len() > FETCH_CAP {
            return Err(format!("{url} exceeded the {FETCH_CAP}-byte download cap"));
        }
        buf.extend_from_slice(&bytes);
    }
    let body = String::from_utf8(buf).map_err(|_| format!("{url} body is not valid UTF-8"))?;
    Ok(PackageFetchResponse { url, status, body })
}

/// Seed a couple of example themes on first run so the picker has something to show
/// (the default look needs no theme). No-op once `themes/` exists.
pub fn seed_themes(app: &tauri::AppHandle) {
    let dir = match themes_dir(app) {
        Ok(d) => d,
        Err(_) => return,
    };
    if dir.exists() {
        return;
    }
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let samples: &[(&str, &str)] = &[
        (
            "amber",
            ":root {\n\t--np-accent: #ffb000;\n\t--np-label: #ffd27f;\n\t--np-track: rgba(255, 176, 0, 0.18);\n}\n",
        ),
        (
            "mono",
            ":root {\n\t--np-accent: #d8dee9;\n\t--np-fg: #eceff4;\n\t--np-label: #9aa5b1;\n\t--np-track: rgba(255, 255, 255, 0.12);\n}\n",
        ),
    ];
    for (name, css) in samples {
        let _ = fs::write(dir.join(format!("{name}.css")), css);
    }
}

/// Shared loop behind `watch_themes`/`watch_layout`/`watch_controls`: watch `dir` (non-recursive)
/// on a dedicated thread for the app's lifetime, and for every filesystem event that passes
/// `filter`, emit `event_name` then run `on_match` (the layout watcher's main-respawn hook; a
/// no-op for the others). `label` tags the log lines. Best-effort: logs and returns on watcher
/// failure, leaving live reload off for that file.
fn watch_and_emit(
    app: tauri::AppHandle,
    dir: PathBuf,
    label: &'static str,
    event_name: &'static str,
    filter: impl Fn(&notify::Event) -> bool + Send + 'static,
    on_match: impl Fn(&tauri::AppHandle) + Send + 'static,
) {
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) {
            Ok(watcher) => watcher,
            Err(err) => {
                log::error("watch", format!("{label} watcher init failed"))
                    .field("error", err)
                    .emit();
                return;
            }
        };
        if let Err(err) = watcher.watch(&dir, notify::RecursiveMode::NonRecursive) {
            log::error("watch", format!("{label} watch failed"))
                .field("error", err)
                .emit();
            return;
        }
        // Keep `watcher` alive by blocking on the channel for the app's lifetime.
        for res in rx {
            match res {
                Ok(event) => {
                    if filter(&event) {
                        let _ = app.emit(event_name, ());
                        on_match(&app);
                    }
                }
                Err(err) => log::warn("watch", format!("{label} watch error"))
                    .field("error", err)
                    .emit(),
            }
        }
    });
}

/// Watch `themes/` and emit `themes_changed` so the frontend live-reloads the active theme.
pub fn watch_themes(app: tauri::AppHandle) -> Result<(), String> {
    let dir = themes_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Only react to `*.css` files (mirrors the layout/controls watchers' filter), so the
    // atomic-write `*.css.tmp` sidecar and any non-theme file dropped in the folder don't
    // spuriously trigger a reload.
    watch_and_emit(
        app,
        dir,
        "themes",
        THEMES_CHANGED_EVENT,
        |event| {
            event
                .paths
                .iter()
                .any(|p| p.extension().and_then(|x| x.to_str()) == Some("css"))
        },
        |_| {},
    );
    Ok(())
}

/// Re-create the primary `main` overlay window (born hidden) after it was torn down to reclaim its
/// renderer (overlay.ts `setMainWindowVisible(false)`). Mirrors the static `main` config in
/// tauri.conf.json; the frontend reveals it — or re-destroys it if the primary is still empty — once
/// its Canvas init runs. Must be called on the main thread (window creation). Best-effort: logs.
/// `reason` tags the log line with which recovery path fired (layout watcher / keepalive).
pub(crate) fn respawn_main_hidden(app: &tauri::AppHandle, reason: &str) {
    match tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("/".into()))
        .title("WidgetSack")
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

/// Watch the config dir for changes to widgets.json and emit `layout_changed`
/// so the frontend can live-reload. Best-effort: logs and returns on failure.
pub fn watch_layout(app: tauri::AppHandle) -> Result<(), String> {
    let path = layout_path(&app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "layout path has no parent".to_string())?
        .to_path_buf();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    watch_and_emit(
        app,
        dir,
        "layout",
        LAYOUT_CHANGED_EVENT,
        move |event| {
            event
                .paths
                .iter()
                .any(|p| p.file_name() == path.file_name())
        },
        |app| {
            // Reclaim: `main` is DESTROYED (not hidden) to free its renderer when the primary
            // monitor is empty (overlay.ts setMainWindowVisible). While it's gone, no window
            // drives overlay reconcile, so an external edit to widgets.json that re-populates
            // the primary would never bring the primary overlay back. Respawn `main` (born
            // hidden) so its own Canvas init decides: reveal if the primary now has widgets, or
            // self-destroy if still empty. Skipped while the studio is open — the studio
            // recreates `main` on close, so we avoid spawn/destroy churn during live editing.
            // Window creation must run on the main thread.
            let app_for_respawn = app.clone();
            let _ = app.run_on_main_thread(move || {
                if app_for_respawn.get_webview_window("main").is_none()
                    && app_for_respawn.get_webview_window("studio").is_none()
                {
                    respawn_main_hidden(&app_for_respawn, "external layout change");
                }
            });
        },
    );
    Ok(())
}

/// Watch the config dir for changes to controls.json and emit `controls_changed` so the frontend
/// can live-reload remaps (e.g. an external edit, or another window saving). Mirrors `watch_layout`.
pub fn watch_controls(app: tauri::AppHandle) -> Result<(), String> {
    let path = controls_path(&app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "controls path has no parent".to_string())?
        .to_path_buf();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    watch_and_emit(
        app,
        dir,
        "controls",
        CONTROLS_CHANGED_EVENT,
        move |event| {
            event
                .paths
                .iter()
                .any(|p| p.file_name() == path.file_name())
        },
        |_| {},
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{client_log_level, stale_backups, truncate_chars, valid_name, version_is_newer};
    use crate::log::LogLevel;

    #[test]
    fn truncate_chars_caps_at_chars_not_bytes() {
        assert_eq!(truncate_chars("short", 10), "short");
        assert_eq!(truncate_chars("abcdef", 3), "abc…");
        // Multi-byte scalars: 3 CHARS, never a split UTF-8 sequence.
        assert_eq!(truncate_chars("日本語です", 3), "日本語…");
        assert_eq!(truncate_chars("", 5), "");
    }

    #[test]
    fn stale_backups_keeps_the_newest_n() {
        let names = vec![
            "widgets.json.bad-1783600000000".to_string(),
            "widgets.json.bad-1783700000000".to_string(),
            "widgets.json.bad-1783500000000".to_string(),
            "widgets.json.bad-1783650000000".to_string(),
        ];
        // Keep the 3 newest → only the oldest is stale.
        assert_eq!(
            stale_backups(names.clone(), 3),
            vec!["widgets.json.bad-1783500000000".to_string()]
        );
        // Fewer than `keep` → nothing to prune.
        assert_eq!(stale_backups(names[..2].to_vec(), 3), Vec::<String>::new());
    }

    #[test]
    fn client_log_level_maps_error_warn_else_info() {
        assert_eq!(client_log_level("error"), LogLevel::Error);
        assert_eq!(client_log_level("warn"), LogLevel::Warn);
        // Anything else — "info", an unknown level, or a typo — is kept at info rather than dropped.
        assert_eq!(client_log_level("info"), LogLevel::Info);
        assert_eq!(client_log_level("debug"), LogLevel::Info);
        assert_eq!(client_log_level(""), LogLevel::Info);
        assert_eq!(client_log_level("ERROR"), LogLevel::Info); // case-sensitive by design
    }

    #[test]
    fn version_is_newer_compares_numerically() {
        assert!(version_is_newer("0.0.42", "0.0.41"));
        assert!(version_is_newer("0.1.0", "0.0.41")); // 0.1.0 > 0.0.41, not string compare
        assert!(version_is_newer("1.0.0", "0.9.9"));
        assert!(!version_is_newer("0.0.41", "0.0.41")); // equal → no update
        assert!(!version_is_newer("0.0.40", "0.0.41")); // older
    }

    #[test]
    fn version_is_newer_tolerates_v_prefix_and_suffixes() {
        assert!(version_is_newer("v0.0.42", "0.0.41"));
        assert!(!version_is_newer("0.0.41-rc1", "0.0.41")); // pre-release suffix stripped → equal
        assert!(!version_is_newer("garbage", "0.0.1")); // unparseable → (0,0,0), no false update
    }

    #[test]
    fn valid_name_accepts_plain_tokens() {
        assert!(valid_name("amber"));
        assert!(valid_name("My Theme 2"));
        assert!(valid_name("dark_mode-v2"));
        assert!(valid_name(&"x".repeat(64)));
    }

    #[test]
    fn valid_name_rejects_unsafe_or_oversized() {
        assert!(!valid_name("")); // empty
        assert!(!valid_name("..")); // traversal
        assert!(!valid_name("a/b")); // separator
        assert!(!valid_name("a\\b")); // separator
        assert!(!valid_name("a..b")); // contains ..
        assert!(!valid_name("name.css")); // dot (extension is added by the caller)
        assert!(!valid_name("a:b")); // reserved char
        assert!(!valid_name("tab\tname")); // control char
        assert!(!valid_name("café")); // non-ASCII
        assert!(!valid_name(&"x".repeat(65))); // too long
        assert!(!valid_name(" lead")); // leading space (Windows trims → name collision)
        assert!(!valid_name("trail ")); // trailing space
        assert!(!valid_name("   ")); // all whitespace
    }

    #[test]
    fn valid_asset_name_requires_css_json_or_js_and_no_traversal() {
        assert!(super::valid_asset_name("theme.css"));
        assert!(super::valid_asset_name("extra.JSON")); // case-insensitive ext
        assert!(super::valid_asset_name("My Theme 2.css")); // spaces ok (valid_name stem)
        assert!(super::valid_asset_name("source.js")); // Phase 2 sandbox script
        assert!(super::valid_asset_name("Source.JS")); // case-insensitive ext
        assert!(!super::valid_asset_name("theme.css.tmp")); // wrong ext (last dot wins)
        assert!(!super::valid_asset_name("evil.tmp.css")); // stem contains a dot
        assert!(!super::valid_asset_name("../theme.css")); // traversal
        assert!(!super::valid_asset_name("..css")); // empty/.. stem
        assert!(!super::valid_asset_name("a/b.css")); // separator
        assert!(!super::valid_asset_name("a\\b.css")); // separator
        assert!(!super::valid_asset_name("theme.exe")); // disallowed ext
        assert!(!super::valid_asset_name("source.mjs")); // js only, not mjs/cjs
        assert!(!super::valid_asset_name("noext")); // no extension
        assert!(!super::valid_asset_name(".css")); // empty stem
        assert!(!super::valid_asset_name("")); // empty
    }

    #[test]
    fn host_allowed_matches_exact_https_domains_only() {
        let hosts = vec!["api.open-meteo.com".to_string(), "example.org".to_string()];
        assert!(super::host_allowed(
            "https://api.open-meteo.com/v1/forecast?latitude=1.35",
            &hosts
        ));
        // URL hosts parse case-folded; a SHOUTING url still matches.
        assert!(super::host_allowed("https://API.OPEN-METEO.COM/v1", &hosts));
        // An explicit default port is elided by the parser → still allowed.
        assert!(super::host_allowed("https://example.org:443/", &hosts));
        // Subdomains are NOT implied — they must be listed.
        assert!(!super::host_allowed("https://sub.example.org/", &hosts));
        assert!(!super::host_allowed(
            "https://example.org.evil.com/",
            &hosts
        ));
        // https only, no explicit ports, no credentials, no IP literals.
        assert!(!super::host_allowed("http://api.open-meteo.com/", &hosts));
        assert!(!super::host_allowed(
            "https://api.open-meteo.com:8443/",
            &hosts
        ));
        assert!(!super::host_allowed("https://user@example.org/", &hosts));
        assert!(!super::host_allowed(
            "https://93.184.216.34/",
            &["93.184.216.34".to_string()]
        ));
        // Host case-insensitivity also covers an uppercased (hand-edited) manifest entry.
        assert!(super::host_allowed(
            "https://example.org/",
            &["EXAMPLE.ORG".to_string()]
        ));
        assert!(!super::host_allowed(
            "https://evil.com/?q=example.org",
            &hosts
        ));
        assert!(!super::host_allowed("not a url", &hosts));
        assert!(!super::host_allowed("https://example.org/", &[]));
    }

    #[test]
    fn resolve_package_source_accepts_the_documented_forms() {
        // owner/repo shorthand → raw manifest on main.
        let r = super::resolve_package_source("acme/widget-pack").unwrap();
        assert_eq!(
            r.manifest_url,
            "https://raw.githubusercontent.com/acme/widget-pack/main/plugin.json"
        );
        assert_eq!(r.display_source, "acme/widget-pack");
        assert_eq!(r.reff, "main");
        // Full repo URL (trailing slash + surrounding whitespace tolerated) → same resolution.
        let r = super::resolve_package_source(" https://github.com/acme/widget-pack/ ").unwrap();
        assert_eq!(
            r.manifest_url,
            "https://raw.githubusercontent.com/acme/widget-pack/main/plugin.json"
        );
        assert_eq!(r.display_source, "acme/widget-pack");
        // /tree/<ref> pins the ref; slash-y branch names survive the splitn.
        let r = super::resolve_package_source("https://github.com/acme/widget-pack/tree/feature/x")
            .unwrap();
        assert_eq!(
            r.manifest_url,
            "https://raw.githubusercontent.com/acme/widget-pack/feature/x/plugin.json"
        );
        assert_eq!(r.reff, "feature/x");
        // Any https URL ending in /plugin.json is used verbatim with ref "direct".
        let r =
            super::resolve_package_source("https://example.com/packs/clock/plugin.json").unwrap();
        assert_eq!(
            r.manifest_url,
            "https://example.com/packs/clock/plugin.json"
        );
        assert_eq!(
            r.display_source,
            "https://example.com/packs/clock/plugin.json"
        );
        assert_eq!(r.reff, "direct");
    }

    #[test]
    fn resolve_package_source_rejects_everything_else() {
        assert!(super::resolve_package_source("http://github.com/a/b").is_none()); // plain http
        assert!(super::resolve_package_source("http://example.com/plugin.json").is_none());
        assert!(super::resolve_package_source("https://example.com/pack").is_none()); // no plugin.json
        assert!(super::resolve_package_source("https://github.com/onlyowner").is_none());
        assert!(super::resolve_package_source("https://github.com/a/b/blob/main/x").is_none());
        assert!(super::resolve_package_source("a/b/c").is_none()); // shorthand has ONE slash
        assert!(super::resolve_package_source("owner").is_none());
        assert!(super::resolve_package_source("ftp://a/b").is_none()); // non-https scheme
        assert!(super::resolve_package_source("a/../b").is_none()); // traversal in a segment
        assert!(super::resolve_package_source("ow ner/repo").is_none()); // bad owner char
        assert!(super::resolve_package_source("").is_none());
    }

    #[test]
    fn asset_url_for_swaps_the_last_segment() {
        assert_eq!(
            super::asset_url_for(
                "https://raw.githubusercontent.com/a/b/main/plugin.json",
                "sky.css"
            ),
            "https://raw.githubusercontent.com/a/b/main/sky.css"
        );
        assert_eq!(
            super::asset_url_for("https://example.com/packs/clock/plugin.json", "extra.json"),
            "https://example.com/packs/clock/extra.json"
        );
    }

    #[test]
    fn manifest_url_from_sidecar_rederives_or_fails_closed() {
        // GitHub provenance: owner/repo + recorded ref.
        assert_eq!(
            super::manifest_url_from_sidecar("acme/pack", "v2").as_deref(),
            Some("https://raw.githubusercontent.com/acme/pack/v2/plugin.json")
        );
        // Direct provenance: the URL itself, re-validated through resolve_package_source.
        assert_eq!(
            super::manifest_url_from_sidecar("https://example.com/p/plugin.json", "direct")
                .as_deref(),
            Some("https://example.com/p/plugin.json")
        );
        // Tampered sidecars fail closed.
        assert!(
            super::manifest_url_from_sidecar("http://example.com/p/plugin.json", "direct")
                .is_none()
        );
        assert!(super::manifest_url_from_sidecar("https://example.com/p", "direct").is_none());
        assert!(super::manifest_url_from_sidecar("acme/pack", "..").is_none());
        assert!(super::manifest_url_from_sidecar("acme", "main").is_none());
        assert!(super::manifest_url_from_sidecar("a/../b", "main").is_none());
    }

    #[test]
    fn install_sidecar_is_unreachable_as_an_asset() {
        // The sidecar must never be readable via read_plugin_package_asset or declarable as a
        // manifest asset — its dotted stem fails valid_name.
        assert!(!super::valid_asset_name(super::INSTALL_SIDECAR));
    }

    #[test]
    fn valid_wallpaper_name_requires_media_ext_and_no_traversal() {
        assert!(super::valid_wallpaper_name("loop.mp4"));
        assert!(super::valid_wallpaper_name("My Wallpaper 2.PNG")); // case-insensitive ext, spaces ok
        assert!(super::valid_wallpaper_name("clip.webm"));
        assert!(!super::valid_wallpaper_name("notes.txt")); // not a media ext
        assert!(!super::valid_wallpaper_name("noext")); // no extension
        assert!(!super::valid_wallpaper_name("../escape.png")); // traversal
        assert!(!super::valid_wallpaper_name("sub/dir.png")); // separator
        assert!(!super::valid_wallpaper_name("a\\b.png")); // separator
        assert!(!super::valid_wallpaper_name("")); // empty
    }
}
