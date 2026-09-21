//! Diagnostics helpers for the studio's Diagnostics tab: where the on-disk log lives and a way to
//! reveal it. The rotating JSON-lines log itself is written by log.rs; this just resolves its
//! path (so the panel can show it / put it in a copied report) and pops the folder in Explorer.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// File name of the rotating log under the app log dir (mirrors log.rs's `LOG_FILE_NAME`).
const LOG_FILE_NAME: &str = "widgetsack.log";

/// Absolute path of the app's log file: what log.rs resolved in `init`, or — before it is wired /
/// if the log dir was unavailable then — the same app-log-dir join it would have made.
fn resolve_log_file(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = crate::log::log_file_path() {
        return Ok(path);
    }
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("no app log dir: {e}"))?;
    Ok(dir.join(LOG_FILE_NAME))
}

/// The directory Explorer should open for a log file path. Pure seam: the parent, or the path
/// itself when it has none (a bare file name).
fn dir_to_reveal(log_file: &Path) -> PathBuf {
    log_file
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| log_file.to_path_buf())
}

/// Absolute path of the rotating log file (shown in the Diagnostics tab + the copied report).
#[tauri::command]
pub fn log_file_path(app: AppHandle) -> Result<String, String> {
    Ok(resolve_log_file(&app)?.to_string_lossy().into_owned())
}

/// Open the log folder in Explorer (creating it first, so a fresh install still has somewhere to
/// land). Best-effort: spawn failure is returned as the error string.
#[tauri::command]
pub fn reveal_log_dir(app: AppHandle) -> Result<(), String> {
    let dir = dir_to_reveal(&resolve_log_file(&app)?);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer.exe")
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::dir_to_reveal;
    use std::path::Path;

    #[test]
    fn dir_to_reveal_is_the_log_files_folder() {
        assert_eq!(
            dir_to_reveal(Path::new(
                "C:/Users/x/AppData/Local/widgetsack/logs/widgetsack.log"
            )),
            Path::new("C:/Users/x/AppData/Local/widgetsack/logs")
        );
        // A bare file name has no usable parent → reveal the path itself rather than "".
        assert_eq!(
            dir_to_reveal(Path::new("widgetsack.log")),
            Path::new("widgetsack.log")
        );
    }
}
