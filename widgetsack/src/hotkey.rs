//! The configurable global edit-mode hotkey. The default stays `Ctrl+Alt+E`, but on Windows AltGr is
//! reported as Ctrl+Alt, so that chord swallows AltGr+E (ę / €) system-wide on Polish, German, French
//! and similar layouts. The accelerator lives in `prefs.json` (`AppPrefs::edit_hotkey`, update.rs);
//! "Off" registers nothing. The studio changes it at runtime (`set_edit_hotkey`): the old shortcut is
//! unregistered and the new one registered; a registration failure (another app owns the chord) is
//! logged and reported back, leaving no edit hotkey active rather than crashing.
//!
//! The rescue hotkey (Ctrl+Alt+Shift+E) is fixed and registered separately (main.rs); the edit hotkey
//! may not take it. Pure seams (`parse_edit_hotkey`, `canonical_edit_hotkey`) hold the validation.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::{command, log, update};

/// The edit hotkey a fresh install (or an unreadable stored value) uses.
pub const DEFAULT_EDIT_HOTKEY: &str = "Ctrl+Alt+E";
/// The stored value meaning "register no edit hotkey".
pub const EDIT_HOTKEY_OFF: &str = "Off";

/// The fixed rescue chord (Ctrl+Alt+Shift+E) — main.rs registers it; the edit hotkey can't reuse it.
pub fn rescue_shortcut() -> Shortcut {
    Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
        Code::KeyE,
    )
}

/// Pure seam: an accelerator string → the shortcut to register (`None` = "Off" / empty). Accepts the
/// plugin's grammar (`Ctrl+Alt+E`, `Control+Shift+KeyE`, …) plus `Win`/`Windows`/`Meta` for the
/// Windows key. Rejects an unknown key/modifier, a chord without Ctrl, Alt or Win (a bare or
/// Shift-only key would be swallowed while typing), and the rescue chord.
pub fn parse_edit_hotkey(text: &str) -> Result<Option<Shortcut>, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case(EDIT_HOTKEY_OFF) {
        return Ok(None);
    }
    let normalized = trimmed
        .split('+')
        .map(|token| {
            let token = token.trim();
            if ["win", "windows", "meta"]
                .iter()
                .any(|alias| token.eq_ignore_ascii_case(alias))
            {
                "Super"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join("+");
    let shortcut: Shortcut = normalized
        .parse()
        .map_err(|e| format!("unrecognised shortcut \"{trimmed}\": {e}"))?;
    if !shortcut
        .mods
        .intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER)
    {
        return Err(format!(
            "\"{trimmed}\" needs Ctrl, Alt or Win so it doesn't block normal typing"
        ));
    }
    if shortcut.id() == rescue_shortcut().id() {
        return Err(format!("\"{trimmed}\" is reserved for the rescue shortcut"));
    }
    Ok(Some(shortcut))
}

/// Pure seam: the value to persist for `text` — `"Off"` for any off spelling, else the trimmed
/// accelerator — or the validation error.
pub fn canonical_edit_hotkey(text: &str) -> Result<String, String> {
    Ok(match parse_edit_hotkey(text)? {
        None => EDIT_HOTKEY_OFF.to_string(),
        Some(_) => text.trim().to_string(),
    })
}

/// What the studio shows: the configured accelerator, whether it is registered right now, and why
/// not when registration failed. Mirrored by `EditHotkeyStatus` in client/src/lib/core/editHotkey.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EditHotkeyStatus {
    pub hotkey: String,
    pub active: bool,
    pub error: Option<String>,
}

impl Default for EditHotkeyStatus {
    fn default() -> Self {
        Self {
            hotkey: EDIT_HOTKEY_OFF.to_string(),
            active: false,
            error: None,
        }
    }
}

/// Managed state. `apply` serializes re-registration; `registered` is the shortcut to unregister on
/// the next change; `status` is read on its own lock, never held across a registration (that waits
/// on the main thread, which may itself be answering a `get_edit_hotkey`).
#[derive(Default)]
pub struct EditHotkeyState {
    apply: Mutex<Option<Shortcut>>,
    status: Mutex<EditHotkeyStatus>,
}

/// Replace the registered edit hotkey with `hotkey`. Errors only for an invalid accelerator (nothing
/// changes); a registration failure returns `Ok` with `active: false` + the error, and no edit
/// hotkey stays registered.
pub fn apply_edit_hotkey<R: Runtime>(
    app: &AppHandle<R>,
    hotkey: &str,
) -> Result<EditHotkeyStatus, String> {
    let canonical = canonical_edit_hotkey(hotkey)?;
    let parsed = parse_edit_hotkey(&canonical)?;
    let state = app.state::<EditHotkeyState>();
    let mut registered = state.apply.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(old) = registered.take()
        && let Err(err) = app.global_shortcut().unregister(old)
    {
        log::warn("hotkey", "failed to unregister previous edit hotkey")
            .field("error", err)
            .emit();
    }
    let status = match parsed {
        None => EditHotkeyStatus::default(),
        Some(shortcut) => {
            match app
                .global_shortcut()
                .on_shortcut(shortcut, |app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        command::windows::toggle_overlay_edit_and_broadcast(app);
                    }
                }) {
                Ok(()) => {
                    *registered = Some(shortcut);
                    EditHotkeyStatus {
                        hotkey: canonical,
                        active: true,
                        error: None,
                    }
                }
                Err(err) => {
                    log::error("hotkey", "failed to register edit hotkey")
                        .field("hotkey", &canonical)
                        .field("error", &err)
                        .emit();
                    EditHotkeyStatus {
                        hotkey: canonical,
                        active: false,
                        error: Some(err.to_string()),
                    }
                }
            }
        }
    };
    *state.status.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
    Ok(status)
}

/// Startup: register the persisted edit hotkey; an invalid stored value (hand-edited prefs.json)
/// falls back to the default.
pub fn init_edit_hotkey<R: Runtime>(app: &AppHandle<R>, stored: &str) {
    if let Err(err) = apply_edit_hotkey(app, stored) {
        log::warn("hotkey", "invalid stored edit hotkey; using the default")
            .field("error", err)
            .emit();
        let _ = apply_edit_hotkey(app, DEFAULT_EDIT_HOTKEY);
    }
}

/// The edit hotkey's current status (any window — the overlay's edit badge names the exit chord).
#[tauri::command(async)]
pub fn get_edit_hotkey(state: tauri::State<'_, EditHotkeyState>) -> EditHotkeyStatus {
    state
        .status
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// Studio: change (or turn off) the edit hotkey. An invalid accelerator is rejected and nothing
/// changes; a valid one is persisted and registered, and a registration failure comes back in the
/// status (`active: false`, `error`).
#[tauri::command(async)]
pub fn set_edit_hotkey(
    window: tauri::WebviewWindow,
    app: AppHandle,
    hotkey: String,
) -> Result<EditHotkeyStatus, String> {
    if window.label() != "studio" {
        return Err("set_edit_hotkey is only allowed from the studio window".into());
    }
    let canonical = canonical_edit_hotkey(&hotkey)?;
    // Persist and register under one lock: two quick changes must not leave prefs.json naming one
    // hotkey while the other is registered (or revert a concurrent update-check toggle).
    update::with_prefs_lock(|| {
        update::modify_prefs(&app, |p| p.edit_hotkey = canonical.clone())?;
        apply_edit_hotkey(&app, &canonical)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        DEFAULT_EDIT_HOTKEY, EditHotkeyStatus, canonical_edit_hotkey, parse_edit_hotkey,
        rescue_shortcut,
    };
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

    fn chord(mods: Modifiers, key: Code) -> Option<Shortcut> {
        Some(Shortcut::new(Some(mods), key))
    }

    #[test]
    fn default_is_ctrl_alt_e() {
        assert_eq!(
            parse_edit_hotkey(DEFAULT_EDIT_HOTKEY),
            Ok(chord(Modifiers::CONTROL | Modifiers::ALT, Code::KeyE))
        );
    }

    #[test]
    fn parses_the_studio_presets_and_win_aliases() {
        assert_eq!(
            parse_edit_hotkey("Win+Alt+E"),
            Ok(chord(Modifiers::SUPER | Modifiers::ALT, Code::KeyE))
        );
        assert_eq!(
            parse_edit_hotkey(" windows + alt + e "),
            Ok(chord(Modifiers::SUPER | Modifiers::ALT, Code::KeyE))
        );
        assert_eq!(
            parse_edit_hotkey("Ctrl+Shift+F9"),
            Ok(chord(Modifiers::CONTROL | Modifiers::SHIFT, Code::F9))
        );
    }

    #[test]
    fn off_and_empty_register_nothing() {
        assert_eq!(parse_edit_hotkey("Off"), Ok(None));
        assert_eq!(parse_edit_hotkey("off"), Ok(None));
        assert_eq!(parse_edit_hotkey("  "), Ok(None));
        assert_eq!(canonical_edit_hotkey("OFF"), Ok("Off".to_string()));
        assert_eq!(canonical_edit_hotkey(""), Ok("Off".to_string()));
    }

    #[test]
    fn rejects_unknown_keys_bare_keys_and_the_rescue_chord() {
        assert!(parse_edit_hotkey("Ctrl+Alt+Banana").is_err());
        assert!(parse_edit_hotkey("Hyper+E").is_err());
        assert!(parse_edit_hotkey("Ctrl++E").is_err());
        // A bare or Shift-only key would be swallowed while typing.
        assert!(parse_edit_hotkey("E").is_err());
        assert!(parse_edit_hotkey("Shift+E").is_err());
        // The rescue chord, in any spelling, is reserved.
        let err = parse_edit_hotkey("Shift+Ctrl+Alt+E").unwrap_err();
        assert!(err.contains("rescue"), "{err}");
        assert!(parse_edit_hotkey("Ctrl+Shift+Alt+E").is_err());
        assert_eq!(
            rescue_shortcut(),
            Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
                Code::KeyE
            )
        );
    }

    #[test]
    fn canonical_keeps_a_valid_accelerator_and_rejects_an_invalid_one() {
        assert_eq!(
            canonical_edit_hotkey("  Win+Alt+E "),
            Ok("Win+Alt+E".to_string())
        );
        assert!(canonical_edit_hotkey("Ctrl+Alt+Nope").is_err());
    }

    #[test]
    fn status_serializes_with_the_client_field_names() {
        let status = EditHotkeyStatus {
            hotkey: "Ctrl+Alt+E".into(),
            active: false,
            error: Some("taken".into()),
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({ "hotkey": "Ctrl+Alt+E", "active": false, "error": "taken" })
        );
        assert_eq!(
            EditHotkeyStatus::default(),
            EditHotkeyStatus {
                hotkey: "Off".into(),
                active: false,
                error: None
            }
        );
    }
}
