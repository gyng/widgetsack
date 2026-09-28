use super::{
    watch::{ChangeOrigin, watch_and_emit},
    windows::respawn_main_hidden,
};
use crate::{
    bridge::LAYOUT_CHANGED_EVENT,
    file_io::{atomic_write, config_root, valid_name},
    log,
};
use serde::Serialize;
use std::{
    collections::VecDeque,
    fs,
    hash::{Hash, Hasher},
    path::PathBuf,
};
use tauri::{Emitter, Manager};

/// Serializes widgets.json read/merge/write transactions across every webview in this process, and
/// remembers what this process itself last wrote (`self_writes`) so the file watcher can tell the
/// app's own saves from an external edit (`watch_layout`).
#[derive(Default)]
pub struct LayoutIoState {
    // The most recent successful backup path, protected by the transaction lock.
    lock: tokio::sync::Mutex<Option<PathBuf>>,
    self_writes: std::sync::Mutex<SelfWrites>,
}

/// How many of the app's most recent layout writes are remembered. More than one because notify
/// delivers a save as 1–3 events and may deliver them after a FOLLOWING save already landed — the
/// content on disk then matches an earlier write, not the latest.
const SELF_WRITES_KEPT: usize = 8;

/// Content hashes of the last few layout documents this process wrote. Pure seam (tested):
/// `record` after a write, `contains` when the watcher fires with the file's current bytes.
#[derive(Default)]
struct SelfWrites {
    hashes: VecDeque<u64>,
}

impl SelfWrites {
    fn record(&mut self, hash: u64) {
        self.hashes.push_back(hash);
        while self.hashes.len() > SELF_WRITES_KEPT {
            self.hashes.pop_front();
        }
    }
    fn contains(&self, hash: u64) -> bool {
        self.hashes.contains(&hash)
    }
}

/// Stable-within-a-process hash of a file's bytes (only ever compared to hashes made here).
fn content_hash(bytes: &[u8]) -> u64 {
    let mut h = std::hash::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

/// Classify the current on-disk layout against the app's recent writes. An unreadable / missing
/// file is `External` (the user deleted it or a write is mid-flight — reload, don't ignore).
fn classify_change(current: Option<&[u8]>, self_writes: &SelfWrites) -> ChangeOrigin {
    match current {
        Some(bytes) if self_writes.contains(content_hash(bytes)) => ChangeOrigin::SelfWrite,
        _ => ChangeOrigin::External,
    }
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

/// Merge the monitor records changed by one editor transaction into the latest widgets.json value.
/// Unknown top-level fields are preserved for forward compatibility; the frontend-owned global fields
/// are replaced (or removed when omitted) from the incoming document.
fn merge_layout_contents(
    mut current: serde_json::Value,
    incoming: serde_json::Value,
    touched_monitors: &[String],
    touched_globals: &[String],
) -> Result<serde_json::Value, String> {
    let current_obj = current
        .as_object_mut()
        .ok_or_else(|| "saved layout is not a JSON object".to_string())?;
    let incoming_obj = incoming
        .as_object()
        .ok_or_else(|| "incoming layout is not a JSON object".to_string())?;
    let incoming_monitors = incoming_obj
        .get("monitors")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "incoming layout has no monitors object".to_string())?;
    let current_monitors = current_obj
        .entry("monitors")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "saved layout monitors is not a JSON object".to_string())?;

    for key in touched_monitors {
        if let Some(value) = incoming_monitors.get(key) {
            current_monitors.insert(key.clone(), value.clone());
        } else {
            current_monitors.remove(key);
        }
    }

    if let Some(version) = incoming_obj.get("version") {
        current_obj.insert("version".into(), version.clone());
    }
    for key in touched_globals {
        if !matches!(key.as_str(), "library" | "theme" | "themeLock" | "tokens") {
            return Err(format!("unknown touched global field: {key}"));
        }
        if let Some(value) = incoming_obj.get(key) {
            current_obj.insert(key.clone(), value.clone());
        } else {
            // These fields are omission-sensitive: absent means reset to the frontend default.
            current_obj.remove(key);
        }
    }
    Ok(current)
}

/// Parse/merge a saved document, allowing recovery only for the exact bytes in a verified backup.
fn merge_saved_layout(
    raw: &str,
    incoming: serde_json::Value,
    touched_monitors: &[String],
    touched_globals: &[String],
    backup: Option<&str>,
) -> Result<serde_json::Value, String> {
    match serde_json::from_str(raw) {
        Ok(current) => merge_layout_contents(current, incoming, touched_monitors, touched_globals),
        Err(_) if backup == Some(raw) => Ok(incoming),
        Err(e) => Err(format!(
            "saved layout is invalid JSON; refusing overwrite without a matching backup: {e}"
        )),
    }
}

/// Write the layout file, creating the config directory if needed. Editor writes identify the monitor
/// records they changed; the backend merges those records under one lock and atomically replaces the
/// file, so concurrent webviews cannot clobber unrelated monitors. A full-document caller (legacy-key
/// migration) omits `touched_monitors` and replaces the document atomically.
#[tauri::command]
pub async fn save_layout(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, LayoutIoState>,
    contents: String,
    touched_monitors: Option<Vec<String>>,
    touched_globals: Option<Vec<String>>,
    recover_corrupt: Option<bool>,
) -> Result<(), String> {
    let backup_path = state.lock.lock().await;
    let path = layout_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let incoming: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|e| format!("incoming layout is invalid JSON: {e}"))?;
    let output = if let Some(touched) = touched_monitors {
        match fs::read_to_string(&path) {
            Ok(raw) => {
                // The frontend requests recovery, but only the backend's actual backup authorizes
                // it. Re-read that file: missing/changed backups cannot authorize an overwrite.
                let backup = if recover_corrupt == Some(true) {
                    backup_path
                        .as_ref()
                        .and_then(|path| fs::read_to_string(path).ok())
                } else {
                    None
                };
                merge_saved_layout(
                    &raw,
                    incoming,
                    &touched,
                    touched_globals.as_deref().unwrap_or_default(),
                    backup.as_deref(),
                )?
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => incoming,
            Err(err) => {
                return Err(format!(
                    "failed to read saved layout; refusing overwrite: {err}"
                ));
            }
        }
    } else {
        incoming
    };
    let rendered = serde_json::to_string_pretty(&output).map_err(|e| e.to_string())?;
    // Remember the exact bytes BEFORE they land so the watcher, however quickly it fires, can
    // recognise this write as ours (see `watch_layout`)…
    if let Ok(mut recent) = state.self_writes.lock() {
        recent.record(content_hash(rendered.as_bytes()));
    }
    atomic_write(&path, &rendered)?;
    // …and tell the other windows ourselves — exactly once, instead of the 1–3 watcher events a
    // save used to fan out (each of which also ran the external-edit respawn hook). The payload
    // names the WRITER (this webview's window label) so the studio can tell its own preview
    // write from another window's save and react to the latter (mirrors `LayoutChangedPayload`
    // in client/src/lib/bridge/contract.ts; the watcher's external-edit emit carries none).
    let _ = app.emit(
        LAYOUT_CHANGED_EVENT,
        serde_json::json!({ "writer": window.label() }),
    );
    Ok(())
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

/// The last-known physical size of each app window, from the window-state plugin's
/// `.window-state.json` (written on a clean exit). Mirrors `WindowGeometryHint` in
/// client/src/lib/core/monitorMigration.ts. Used ONCE, by the layout-key migration: when Windows has
/// re-numbered `\\.\DISPLAYn` since a layout was saved, the name alone points at the wrong monitor,
/// but the overlay window that rendered that key was exactly monitor-sized — so its saved size
/// identifies the physical monitor the layout belongs on. Best-effort: empty on any failure.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WindowGeometryHint {
    pub label: String,
    pub width: f64,
    pub height: f64,
    /// Saved position (physical px); `None` for entries without one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
}

/// Pure seam: `.window-state.json` (`{ "<label>": { "width": w, "height": h, "x": x, "y": y, … }, … }`)
/// → hints. Entries without both numeric dimensions are skipped (a position is optional); anything
/// unparseable yields an empty list.
pub fn parse_window_state_hints(json: &str) -> Vec<WindowGeometryHint> {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(label, v)| {
            let width = v.get("width")?.as_f64()?;
            let height = v.get("height")?.as_f64()?;
            let x = v.get("x").and_then(serde_json::Value::as_f64);
            let y = v.get("y").and_then(serde_json::Value::as_f64);
            Some(WindowGeometryHint {
                label: label.clone(),
                width,
                height,
                x,
                y,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn window_state_hints(app: tauri::AppHandle) -> Vec<WindowGeometryHint> {
    // The plugin writes to the plain app config dir (not the `multi/` sub-root config_root uses).
    let Ok(dir) = app.path().app_config_dir() else {
        return Vec::new();
    };
    match fs::read_to_string(dir.join(".window-state.json")) {
        Ok(json) => parse_window_state_hints(&json),
        Err(_) => Vec::new(),
    }
}

/// Copy the CURRENT widgets.json aside as `widgets.json.bad-<epoch-ms>` — called by the frontend
/// when it fails to PARSE the layout, BEFORE the running app (now on an in-memory default) can
/// save over the original and destroy whatever was hand-recoverable in it. Keeps the newest
/// `LAYOUT_BACKUPS_KEPT` backups, pruning older ones. Returns the backup path, or `None` when
/// there is no layout file to back up. Best-effort by design: the caller logs, never blocks on it.
#[tauri::command]
pub async fn backup_layout(
    app: tauri::AppHandle,
    state: tauri::State<'_, LayoutIoState>,
) -> Result<Option<String>, String> {
    let mut backup_path = state.lock.lock().await;
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
    *backup_path = Some(backup.clone());
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
    atomic_write(&path, &contents)?;
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

/// Watch the config dir for EXTERNAL changes to widgets.json (an editor, a manual hot-fix) and emit
/// `layout_changed` so the frontend can live-reload. The app's own `save_layout` writes are
/// recognised by content hash (`LayoutIoState::self_writes`) and ignored here — `save_layout`
/// emits the event itself, once, and must never trigger the respawn hook below. Best-effort: logs
/// and returns on failure.
pub fn watch_layout(app: tauri::AppHandle) -> Result<(), String> {
    let path = layout_path(&app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "layout path has no parent".to_string())?
        .to_path_buf();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file_name = path.file_name().map(|n| n.to_os_string());
    let classify_path = path.clone();
    watch_and_emit(
        app,
        dir,
        "layout",
        LAYOUT_CHANGED_EVENT,
        move |event| {
            event
                .paths
                .iter()
                .any(|p| p.file_name().map(|n| n.to_os_string()) == file_name)
        },
        move |app| {
            let current = fs::read(&classify_path).ok();
            match app.try_state::<LayoutIoState>() {
                Some(state) => match state.self_writes.lock() {
                    Ok(recent) => classify_change(current.as_deref(), &recent),
                    Err(_) => ChangeOrigin::External,
                },
                None => ChangeOrigin::External,
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recovery_requires_the_exact_backed_up_contents() {
        let incoming = json!({"version": 2, "monitors": {"a": {"floating": []}}});
        let raw = "{broken";
        assert!(merge_saved_layout(raw, incoming.clone(), &["a".into()], &[], None).is_err());
        assert!(
            merge_saved_layout(raw, incoming.clone(), &["a".into()], &[], Some("{older")).is_err()
        );
        assert_eq!(
            merge_saved_layout(raw, incoming.clone(), &["a".into()], &[], Some(raw)).unwrap(),
            incoming
        );
        // A valid edit after backup must be merged, never replaced as recovery.
        let valid = r#"{"version":2,"monitors":{"b":{"floating":[]}},"theme":"keep"}"#;
        let merged = merge_saved_layout(valid, incoming, &["a".into()], &[], Some(raw)).unwrap();
        assert!(merged["monitors"].get("b").is_some());
        assert_eq!(merged["theme"], "keep");
    }

    #[test]
    fn self_writes_recognise_recent_content_and_forget_old() {
        let mut recent = SelfWrites::default();
        let a = content_hash(b"{\"a\":1}");
        let b = content_hash(b"{\"a\":2}");
        assert_ne!(a, b);
        assert_eq!(
            classify_change(Some(b"{\"a\":1}"), &recent),
            ChangeOrigin::External
        );
        recent.record(a);
        assert_eq!(
            classify_change(Some(b"{\"a\":1}"), &recent),
            ChangeOrigin::SelfWrite
        );
        // A later save doesn't make an older, still-in-flight one look external…
        recent.record(b);
        assert_eq!(
            classify_change(Some(b"{\"a\":1}"), &recent),
            ChangeOrigin::SelfWrite
        );
        // …but the memory is bounded: after many more writes the oldest is forgotten.
        for i in 0..super::SELF_WRITES_KEPT {
            recent.record(content_hash(format!("{i}").as_bytes()));
        }
        assert_eq!(
            classify_change(Some(b"{\"a\":1}"), &recent),
            ChangeOrigin::External
        );
        // A missing/unreadable file is an external change (deleted by hand → reload to empty).
        assert_eq!(classify_change(None, &recent), ChangeOrigin::External);
    }

    #[test]
    fn layout_transaction_replaces_only_explicitly_touched_monitors_and_global_fields() {
        let current = json!({
            "version": 2,
            "monitors": {
                "a": { "root": { "id": "old-a" } },
                "b": { "root": { "id": "keep-b" } }
            },
            "theme": "old",
            "tokens": { "--old": "1" },
            "future": { "preserve": true }
        });
        let incoming = json!({
            "version": 2,
            "monitors": {
                "a": { "root": { "id": "new-a" } },
                "b": { "root": { "id": "stale-b" } }
            },
            "themeLock": false
        });
        let merged = merge_layout_contents(
            current,
            incoming,
            &["a".into()],
            &["theme".into(), "themeLock".into(), "tokens".into()],
        )
        .unwrap();
        assert_eq!(merged["monitors"]["a"]["root"]["id"], "new-a");
        assert_eq!(merged["monitors"]["b"]["root"]["id"], "keep-b");
        assert_eq!(merged["themeLock"], false);
        assert!(merged.get("theme").is_none());
        assert!(merged.get("tokens").is_none());
        assert_eq!(merged["future"]["preserve"], true);
    }

    #[test]
    fn layout_transaction_can_replace_multiple_monitors() {
        let current = json!({
            "version": 2,
            "monitors": { "a": 1, "b": 2, "c": 3 }
        });
        let incoming = json!({
            "version": 2,
            "monitors": { "a": 10, "b": 20 }
        });
        let merged =
            merge_layout_contents(current, incoming, &["a".into(), "b".into()], &[]).unwrap();
        assert_eq!(merged["monitors"], json!({ "a": 10, "b": 20, "c": 3 }));
    }

    #[test]
    fn layout_transaction_preserves_newer_globals_for_monitor_only_save() {
        let current = json!({
            "version": 2,
            "monitors": { "a": { "root": { "id": "old-a" } } },
            "library": { "version": 1, "defs": [{ "id": "new-library" }] },
            "theme": "new-theme",
            "themeLock": false,
            "tokens": { "--new": "2" }
        });
        let stale_incoming = json!({
            "version": 2,
            "monitors": { "a": { "root": { "id": "new-a" } } },
            "library": { "version": 1, "defs": [{ "id": "old-library" }] },
            "theme": "old-theme",
            "tokens": { "--old": "1" }
        });

        let merged = merge_layout_contents(current, stale_incoming, &["a".into()], &[]).unwrap();

        assert_eq!(merged["monitors"]["a"]["root"]["id"], "new-a");
        assert_eq!(merged["library"]["defs"][0]["id"], "new-library");
        assert_eq!(merged["theme"], "new-theme");
        assert_eq!(merged["themeLock"], false);
        assert_eq!(merged["tokens"], json!({ "--new": "2" }));
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
    fn window_state_hints_keep_label_and_size_and_skip_incomplete_entries() {
        let json = r#"{
            "studio": { "width": 1767, "height": 1016, "x": 1027, "y": 380, "maximized": false },
            "overlay-DISPLAY3": { "width": 2560, "height": 720, "x": 652, "y": 2160 },
            "broken": { "width": "wide" },
            "partial": { "height": 5 }
        }"#;
        let mut hints = parse_window_state_hints(json);
        hints.sort_by(|a, b| a.label.cmp(&b.label));
        assert_eq!(
            hints,
            vec![
                WindowGeometryHint {
                    label: "overlay-DISPLAY3".into(),
                    width: 2560.0,
                    height: 720.0,
                    x: Some(652.0),
                    y: Some(2160.0)
                },
                WindowGeometryHint {
                    label: "studio".into(),
                    width: 1767.0,
                    height: 1016.0,
                    x: Some(1027.0),
                    y: Some(380.0)
                },
            ]
        );
    }

    #[test]
    fn window_state_hints_are_empty_for_garbage() {
        assert!(parse_window_state_hints("").is_empty());
        assert!(parse_window_state_hints("[1,2]").is_empty());
        assert!(parse_window_state_hints("{not json").is_empty());
    }
}
