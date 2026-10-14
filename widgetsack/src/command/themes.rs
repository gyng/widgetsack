use super::watch::{ChangeOrigin, watch_and_emit};
use crate::{
    bridge::THEMES_CHANGED_EVENT,
    file_io::{atomic_write, atomic_write_new, config_root, list_named_files, valid_name},
};
use std::{fs, path::PathBuf};

// ---- themes (Phase 7c): a `themes/<name>.css` plugin folder in the app config dir ----

fn themes_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = config_root(app)?;
    Ok(dir.join("themes"))
}

fn theme_event_matches(event: &notify::Event) -> bool {
    event.paths.iter().any(|path| {
        path.extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("css"))
    })
}

/// The theme names (file stems of `themes/*.css`), sorted. The frontend adds a synthetic
/// "(default)" option (no theme = the meters' token fallbacks).
#[tauri::command(async)]
pub fn list_themes(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    list_named_files(&themes_dir(&app)?, ".css")
}

/// The CSS of theme `name` (a bare file stem), or `None` if it doesn't exist.
#[tauri::command(async)]
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
/// `overwrite: false` rejects an existing destination at publication time, including concurrent saves.
#[tauri::command(async)]
pub fn save_theme(
    app: tauri::AppHandle,
    name: String,
    contents: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    if !valid_name(&name) {
        return Err("invalid theme name".to_string());
    }
    let dir = themes_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}.css"));
    if overwrite.unwrap_or(true) {
        atomic_write(&path, &contents)
    } else {
        atomic_write_new(&path, &contents)
    }
}

/// Delete theme `name` → removes `themes/<name>.css`. Ok even if it's already gone (idempotent),
/// mirroring `delete_layout`. The themes watcher then emits `themes_changed` so the picker refreshes.
#[tauri::command(async)]
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
        theme_event_matches,
        |_| ChangeOrigin::External,
        |_| {},
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_events_accept_case_variants_without_tracking_temporary_files() {
        for (file, expected) in [
            ("Nord.CSS", true),
            ("normal.css", true),
            ("normal.css.tmp-1", false),
            ("notes.txt", false),
        ] {
            let event = notify::Event::new(notify::EventKind::Any).add_path(PathBuf::from(file));
            assert_eq!(theme_event_matches(&event), expected, "{file}");
        }
    }
}
