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

#[cfg(windows)]
const PREF_SUBKEY: &str = r"Software\io.github.gyng\widgetsack";
#[cfg(windows)]
const PREF_VALUE: &str = "LaunchAtLogin";

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
    let result = if want { manager.enable() } else { manager.disable() };
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
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }
    manager.is_enabled().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::reconcile_action;

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
