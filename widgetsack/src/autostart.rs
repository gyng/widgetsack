//! Launch-at-login preference + reconciliation.
//!
//! `tauri-plugin-autostart`'s only state is the Windows `…\CurrentVersion\Run\widgetsack` value.
//! Tauri's NSIS uninstaller deletes that value on every uninstall EXCEPT an auto-updater run
//! (`$UpdateMode = 1`) — and we ship manually-downloaded installers, so each upgrade runs the old
//! uninstaller with `$UpdateMode = 0` and wipes it. Nothing restores it, so the toggle never
//! survives an install.
//!
//! Fix: keep a durable PREFERENCE in HKCU (`Software\io.github.gyng\widgetsack` → `LaunchAtLogin`,
//! REG_DWORD) — written by both the in-app Settings toggle (`set_autostart_enabled`) and the
//! installer's finish-page checkbox — and re-assert the Run key from it on every startup
//! (`reconcile`). The preference is the single source of truth; the app owns the Run key.
//!
//! We write the `…\Run` value OURSELVES (`enable_autostart`) instead of via the plugin's
//! `enable()`. `auto-launch` 0.5.0 formats the value as `format!("{} {}", path, args.join(" "))`,
//! which — with our empty args — yields the bare exe path plus a **trailing space** and no quotes
//! (e.g. `C:\…\widgetsack.exe `). Windows' logon Run-key launcher silently refuses to execute that
//! malformed command, so the app never autostarts even though the toggle reports "enabled" (the
//! plugin's `is_enabled()` only checks that the value exists, not its content). We write a clean,
//! quoted, trailing-space-free command instead; the plugin's read/`disable` paths are unaffected.

#[cfg(windows)]
const PREF_SUBKEY: &str = r"Software\io.github.gyng\widgetsack";
#[cfg(windows)]
const PREF_VALUE: &str = "LaunchAtLogin";

/// HKCU Run key + the value name the autostart plugin registers us under (product name).
#[cfg(windows)]
const RUN_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const RUN_VALUE_NAME: &str = "widgetsack";
/// Task Manager's per-user startup override list, and the "enabled" marker auto-launch writes there
/// (first byte 0x02, trailing eight bytes zero). We mirror it so a stale "disabled" record can't
/// suppress the entry after we re-enable.
#[cfg(windows)]
const STARTUP_APPROVED_SUBKEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
#[cfg(windows)]
const STARTUP_APPROVED_ENABLED: [u8; 12] = [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/// The exact command to register under `…\CurrentVersion\Run`. Quoted (so an install path with
/// spaces still launches) and with **no trailing space** — the two things that make Windows skip
/// the entry at logon when auto-launch writes it. We take no autostart args, so this is just the
/// quoted exe path.
#[cfg_attr(not(windows), allow(dead_code))]
fn run_command(exe: &str) -> String {
    format!("\"{exe}\"")
}

/// Register the app to launch at login by writing the Run value ourselves (clean/quoted), bypassing
/// auto-launch's malformed-value bug. Non-Windows keeps the plugin's cross-platform path.
#[cfg(windows)]
fn enable_autostart(_app: &tauri::AppHandle) -> Result<(), String> {
    use winreg::RegKey;
    use winreg::RegValue;
    use winreg::enums::RegType::REG_BINARY;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let command = run_command(&exe.to_string_lossy());

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey_with_flags(RUN_SUBKEY, KEY_SET_VALUE)
        .map_err(|e| e.to_string())?
        .set_value(RUN_VALUE_NAME, &command)
        .map_err(|e| e.to_string())?;

    // Best-effort: mark the entry ENABLED in Task Manager's list (the key may not exist yet).
    if let Ok(approved) = hkcu.open_subkey_with_flags(STARTUP_APPROVED_SUBKEY, KEY_SET_VALUE) {
        let _ = approved.set_raw_value(
            RUN_VALUE_NAME,
            &RegValue {
                vtype: REG_BINARY,
                bytes: STARTUP_APPROVED_ENABLED.to_vec(),
            },
        );
    }
    Ok(())
}

#[cfg(not(windows))]
fn enable_autostart(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().enable().map_err(|e| e.to_string())
}

/// Read the saved launch-at-login preference. `None` = never configured (installer checkbox left
/// untouched AND the in-app toggle never used) → leave the OS autostart state alone.
#[cfg(windows)]
pub fn read_pref() -> Option<bool> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu.open_subkey_with_flags(PREF_SUBKEY, KEY_READ).ok()?;
    let value: u32 = key.get_value(PREF_VALUE).ok()?;
    Some(value != 0)
}

#[cfg(not(windows))]
pub fn read_pref() -> Option<bool> {
    None
}

/// Persist the launch-at-login preference (the installer writes the same key/value from NSIS).
#[cfg(windows)]
pub fn write_pref(enabled: bool) -> Result<(), String> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey(PREF_SUBKEY).map_err(|e| e.to_string())?;
    key.set_value(PREF_VALUE, &u32::from(enabled))
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
pub fn write_pref(_enabled: bool) -> Result<(), String> {
    Ok(())
}

/// Pure seam: the action needed to bring the OS autostart registration in line with the saved
/// preference, or `None` when nothing should change. `pref == None` (never configured) is always
/// a no-op — we never touch a system we were never told about.
pub fn reconcile_action(pref: Option<bool>, current: bool) -> Option<bool> {
    match pref {
        Some(want) if want != current => Some(want),
        _ => None,
    }
}

/// Re-assert the OS autostart registration from the saved preference. This is the line that makes
/// the setting survive installs: after an upgrade wipes the `…\Run` value, the first launch (the
/// installer's "Run WidgetSack" finish-page checkbox, or the user reopening the app) restores it.
/// Best-effort — failures are logged, never fatal.
pub fn reconcile(app: &tauri::AppHandle) {
    use tauri_plugin_autostart::ManagerExt;

    let manager = app.autolaunch();
    let current = match manager.is_enabled() {
        Ok(v) => v,
        Err(err) => {
            crate::log::warn("startup", "autostart is_enabled failed")
                .field("error", err)
                .emit();
            return;
        }
    };
    let Some(want) = reconcile_action(read_pref(), current) else {
        return;
    };
    let result = if want {
        enable_autostart(app)
    } else {
        manager.disable().map_err(|e| e.to_string())
    };
    if let Err(err) = result {
        crate::log::error("startup", "failed to reconcile autostart from preference")
            .field("enable", want)
            .field("error", err)
            .emit();
    }
}

/// Whether the app is currently registered to launch at login (the live OS state).
#[tauri::command]
pub fn get_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Enable/disable launch at login: persist the durable preference (so it survives installs) AND
/// update the OS registration. Returns the re-read OS state.
#[tauri::command]
pub fn set_autostart_enabled(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    write_pref(enabled)?;
    if enabled {
        enable_autostart(&app)?;
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())?;
    }
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{reconcile_action, run_command};

    #[test]
    fn run_command_is_quoted_and_has_no_trailing_space() {
        // Regression: auto-launch 0.5.0 writes `format!("{} {}", path, "")` → a bare, unquoted path
        // with a trailing space, which Windows' logon Run-key launcher silently skips. Ours must be
        // quoted (spaces in the install path still launch) and free of any trailing space.
        let cmd = run_command(r"C:\Users\gng\AppData\Local\widgetsack\widgetsack.exe");
        assert_eq!(
            cmd,
            r#""C:\Users\gng\AppData\Local\widgetsack\widgetsack.exe""#
        );
        assert!(cmd.starts_with('"') && cmd.ends_with('"'));
        assert!(!cmd.ends_with(' '));
    }

    #[test]
    fn run_command_quotes_paths_containing_spaces() {
        let cmd = run_command(r"C:\Program Files\widgetsack\widgetsack.exe");
        assert_eq!(cmd, r#""C:\Program Files\widgetsack\widgetsack.exe""#);
    }

    #[test]
    fn pref_none_is_always_a_noop() {
        assert_eq!(reconcile_action(None, true), None);
        assert_eq!(reconcile_action(None, false), None);
    }

    #[test]
    fn enables_when_pref_on_but_os_off() {
        // The upgrade-recovery case: pref survived, the Run key got wiped.
        assert_eq!(reconcile_action(Some(true), false), Some(true));
    }

    #[test]
    fn disables_when_pref_off_but_os_on() {
        assert_eq!(reconcile_action(Some(false), true), Some(false));
    }

    #[test]
    fn noop_when_os_already_matches_pref() {
        assert_eq!(reconcile_action(Some(true), true), None);
        assert_eq!(reconcile_action(Some(false), false), None);
    }
}
