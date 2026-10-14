use crate::file_io::{atomic_write, atomic_write_new, config_root, list_named_files, valid_name};
use std::{fs, path::PathBuf};

// ---- sacks: shareable bundles (`sacks/<name>.sack.json` in the app config dir) ----
// A "sack" packs the widget library + active theme CSS + token overrides as one JSON file so a
// user can share/reuse a set. Dumb I/O to a fixed folder (no native file picker); the frontend
// owns the format + merge logic (core/sack.ts).

fn sacks_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = config_root(app)?;
    Ok(dir.join("sacks"))
}

/// The sack names (file stems of `sacks/*.sack.json`), sorted.
#[tauri::command(async)]
pub fn list_sacks(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    list_named_files(&sacks_dir(&app)?, ".sack.json")
}

/// The JSON of sack `name`, or `None` if it doesn't exist. The frontend parses/validates it.
#[tauri::command(async)]
pub fn read_sack(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    if !valid_name(&name) {
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
#[tauri::command(async)]
pub fn write_sack(
    app: tauri::AppHandle,
    name: String,
    contents: String,
    overwrite: Option<bool>,
) -> Result<String, String> {
    if !valid_name(&name) {
        return Err("invalid sack name".to_string());
    }
    let dir = sacks_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}.sack.json"));
    if overwrite.unwrap_or(true) {
        atomic_write(&path, &contents)?;
    } else {
        atomic_write_new(&path, &contents)?;
    }
    Ok(path.to_string_lossy().into_owned())
}

// ---- saved layouts: named layout profiles (`layouts/<name>.layout.json` in the app config dir) ----
// A saved layout is one monitor's arrangement (root tree + floating widgets) the user can name, list,
