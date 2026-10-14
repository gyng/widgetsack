use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::Manager;

/// List supported files using case-insensitive suffixes and original filename stems.
pub(crate) fn list_named_files(dir: &Path, suffix: &str) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(names),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !fs::metadata(&path)
            .map_err(|error| error.to_string())?
            .is_file()
        {
            continue;
        }
        if let Some(file) = path.file_name().and_then(|name| name.to_str())
            && let Some(split) = file.len().checked_sub(suffix.len())
            && let (Some(stem), Some(extension)) = (file.get(..split), file.get(split..))
            && extension.eq_ignore_ascii_case(suffix)
            && valid_name(stem)
        {
            names.push(stem.to_string());
        }
    }
    names.sort();
    Ok(names)
}

/// The app config dir — isolated into a `multi/` subfolder for an extra dev instance
/// (`crate::multi_instance`), so a dev build run alongside the installed release never reads or writes
/// the release's widgets.json / themes / layouts / sacks. The real config dir otherwise. All the
/// config/theme/layout/sack/wallpaper/plugin paths (and their file watchers) go through this.
pub(crate) fn config_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let base = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(if crate::multi_instance() {
        base.join("multi")
    } else {
        base
    })
}

/// Write `contents` to `path` atomically: write a sibling temp file, then rename it onto the target
/// (a rename is atomic on the same volume), so a concurrent reader — or a crash mid-write — never
/// sees a truncated/partial file. The temp name appends a process ID and sequence after `.tmp-`, so its
/// extension is neither `css` nor `json`, and the directory watchers, which filter by filename,
/// ignore it. Best-effort cleanup of the temp file on failure.
pub(crate) fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    atomic_write_mode(path, contents, true)
}

/// Publish a complete new file only if its destination is still unused.
pub(crate) fn atomic_write_new(path: &Path, contents: &str) -> Result<(), String> {
    atomic_write_mode(path, contents, false)
}

fn atomic_write_mode(path: &Path, contents: &str, overwrite: bool) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "write path has no file name".to_string())?;
    let mut tmp = path.to_path_buf();
    let seq = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
    tmp.set_file_name(format!("{file_name}.tmp-{}-{seq}", std::process::id()));
    if let Err(err) = fs::write(&tmp, contents) {
        let _ = fs::remove_file(&tmp);
        return Err(err.to_string());
    }
    replace_file(&tmp, path, overwrite).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path, overwrite: bool) -> Result<(), String> {
    if overwrite {
        fs::rename(from, to).map_err(|e| e.to_string())
    } else {
        fs::hard_link(from, to).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(from);
        Ok(())
    }
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path, overwrite: bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    use windows::core::PCWSTR;

    let from_wide: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to_wide: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        MoveFileExW(
            PCWSTR(from_wide.as_ptr()),
            PCWSTR(to_wide.as_ptr()),
            if overwrite {
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
            } else {
                MOVEFILE_WRITE_THROUGH
            },
        )
    }
    .map_err(|e| e.to_string())
}

/// Shared filename allowlist for user-named config files (themes, sacks). The name becomes a
/// path segment, so it must be a safe, bounded token: 1–64 chars of `[A-Za-z0-9 _-]` only. This
/// rejects control chars, path separators, `..`, and Windows-reserved characters by construction;
/// the explicit empty/`..`/separator checks below are kept as a defensive backstop. Leading/trailing
/// spaces are rejected too — Windows silently trims trailing spaces/dots from filenames, so `"a "`
/// and `"a"` would collide on disk and a delete-by-name could miss.
pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name == name.trim()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '-')
        && !windows_device_name(name)
}

pub(crate) fn windows_device_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return true;
    }
    ["COM", "LPT"].iter().any(|prefix| {
        upper.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_file_writes_never_replace_existing_or_concurrently_created_files() {
        let dir = std::env::temp_dir().join(format!(
            "widgetsack-new-file-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("theme.css");
        fs::write(&path, "original").unwrap();
        assert!(atomic_write_new(&path, "replacement").is_err());
        #[cfg(windows)]
        assert!(atomic_write_new(&dir.join("THEME.CSS"), "case replacement").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        fs::remove_file(&path).unwrap();
        let barrier = std::sync::Barrier::new(2);
        let results = std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                barrier.wait();
                atomic_write_new(&path, "first")
            });
            let second = scope.spawn(|| {
                barrier.wait();
                atomic_write_new(&path, "second")
            });
            [first.join().unwrap(), second.join().unwrap()]
        });
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let expected = if results[0].is_ok() {
            "first"
        } else {
            "second"
        };
        assert_eq!(fs::read_to_string(&path).unwrap(), expected);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn named_file_lists_include_case_variants_and_valid_file_entries() {
        let dir = std::env::temp_dir().join(format!(
            "widgetsack-file-list-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        for file in [
            "Nord.CSS",
            "Work.LAYOUT.JSON",
            "Shared.SACK.JSON",
            "bad.name.css",
            "plain.css",
            "notes.txt",
            "🙂x",
        ] {
            fs::write(dir.join(file), "keep").unwrap();
        }
        fs::create_dir(dir.join("folder.css")).unwrap();
        assert_eq!(
            list_named_files(&dir, ".css").unwrap(),
            vec!["Nord", "plain"]
        );
        assert_eq!(
            list_named_files(&dir, ".layout.json").unwrap(),
            vec!["Work"]
        );
        assert_eq!(
            list_named_files(&dir, ".sack.json").unwrap(),
            vec!["Shared"]
        );
        assert!(list_named_files(&dir.join("notes.txt"), ".css").is_err());
        assert!(
            list_named_files(&dir.join("missing"), ".css")
                .unwrap()
                .is_empty()
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_write_replaces_an_existing_file() {
        let dir = std::env::temp_dir().join(format!(
            "widgetsack-atomic-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(&path, "old").unwrap();

        atomic_write(&path, "new").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
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
        for reserved in [
            "CON", "con", "PRN", "AUX", "NUL", "COM1", "com9", "LPT1", "lpt9",
        ] {
            assert!(
                !valid_name(reserved),
                "Windows device name {reserved} must be rejected"
            );
        }
    }
}
