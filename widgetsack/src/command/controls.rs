use super::watch::{ChangeOrigin, watch_and_emit};
use crate::{
    bridge::CONTROLS_CHANGED_EVENT,
    file_io::{atomic_write, config_root},
};
use std::{fs, path::PathBuf};

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
    atomic_write(&path, &contents)
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
        |_| ChangeOrigin::External,
        |_| {},
    );
    Ok(())
}
