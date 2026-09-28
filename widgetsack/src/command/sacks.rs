use crate::file_io::{atomic_write, config_root, valid_name};
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
#[tauri::command]
pub fn write_sack(app: tauri::AppHandle, name: String, contents: String) -> Result<String, String> {
    if !valid_name(&name) {
        return Err("invalid sack name".to_string());
    }
    let dir = sacks_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}.sack.json"));
    atomic_write(&path, &contents)?;
    Ok(path.to_string_lossy().into_owned())
}

// ---- saved layouts: named layout profiles (`layouts/<name>.layout.json` in the app config dir) ----
// A saved layout is one monitor's arrangement (root tree + floating widgets) the user can name, list,
