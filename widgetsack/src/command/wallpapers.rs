use crate::file_io::config_root;
use std::{fs, path::PathBuf};

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

#[cfg(test)]
mod tests {

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
