//! Background update check. The app ships NO auto-updater (a signed updater was declined), so this
//! only *tells* the user a newer GitHub release exists: a task polls the releases API 30 s after
//! boot and then every 6 h, keeps the latest `AppUpdate` in managed state (`get_app_update` for a
//! studio that opens later), pushes each result to the webview as an `app_update` event, and
//! relabels the tray's "Update available: vX.Y.Z" item — which opens the release page through
//! `open_url` (ShellExecuteW, restricted to the project's own https://github.com/ URLs).
//!
//! The manual About-panel check (`command::check_app_update`) funnels through `publish` too, so
//! the tray + studio badge reflect whichever check ran last. Pure seams (`tray_label`,
//! `url_allowed`, `parse_prefs`) hold the logic and the tests.
//!
//! The background check is OPT-IN (off by default): it is a periodic call to a third-party API the
//! user never asked for, so it runs only when the `update_check` preference in `<config>/prefs.json`
//! is true (About tab → "check for updates automatically"). The manual check always works.

use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::command::{AppUpdate, fetch_app_update};
use crate::log;

/// Tauri event carrying the latest successful `AppUpdate` to every webview. Mirrored in
/// client/src/lib/bridge/contract.ts (`EVENTS.appUpdate`) — keep both in sync (AGENTS.md §5).
pub const APP_UPDATE_EVENT: &str = "app_update";

/// Tray menu item id for the update entry (main.rs builds the item and routes its click here).
pub const TRAY_ITEM_ID: &str = "update";

/// Delay before the first background check (let boot settle; the network may not be up yet).
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
/// Interval between background checks. Releases are infrequent; 6 h keeps well clear of the
/// unauthenticated GitHub API quota (60 req/h) even across several instances.
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Only the project's own release pages may be opened from the tray / studio "open release"
/// affordance: the URL comes back from the GitHub API (untrusted input), so it is pinned to https on
/// github.com under the repo path rather than handed to the shell verbatim.
const ALLOWED_URL_PREFIX: &str = "https://github.com/gyng/widgetsack";

/// Managed state: the last successful check + the tray item the checker relabels.
#[derive(Default)]
pub struct UpdateState {
    latest: Mutex<Option<AppUpdate>>,
    tray_item: Mutex<Option<MenuItem<Wry>>>,
}

/// App-level preferences persisted in `<config>/prefs.json`. Mirrors `AppPrefs` in
/// client/src/lib/core/updateNotice.ts. Unknown fields are ignored; missing ones take the defaults,
/// so an older/partial file never fails to load.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct AppPrefs {
    /// Poll GitHub for a newer release in the background (opt-in — `false` by default; the manual
    /// check is unaffected).
    pub update_check: bool,
}

const PREFS_FILE: &str = "prefs.json";

/// Pure seam: `prefs.json` text → prefs. Garbage or a missing file → the defaults.
pub fn parse_prefs(json: &str) -> AppPrefs {
    serde_json::from_str(json).unwrap_or_default()
}

fn prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::command::config_root(app)
        .ok()
        .map(|d| d.join(PREFS_FILE))
}

/// The persisted preferences (defaults when the file is absent or unreadable).
pub fn load_prefs(app: &AppHandle) -> AppPrefs {
    prefs_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| parse_prefs(&s))
        .unwrap_or_default()
}

fn save_prefs(app: &AppHandle, prefs: &AppPrefs) -> Result<(), String> {
    let path = prefs_path(app).ok_or("no config dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    crate::command::atomic_write(&path, &json)
}

/// Studio: the current preferences.
#[tauri::command]
pub fn get_app_prefs(app: AppHandle) -> AppPrefs {
    load_prefs(&app)
}

/// Studio: turn the background update check on/off. Enabling runs a check right away (so the
/// toggle has a visible effect); disabling relabels the tray to say checks are off.
#[tauri::command]
pub async fn set_update_check(app: AppHandle, enabled: bool) -> Result<AppPrefs, String> {
    let mut prefs = load_prefs(&app);
    prefs.update_check = enabled;
    save_prefs(&app, &prefs)?;
    if enabled {
        run_check(&app).await;
    } else {
        set_tray(&app, &tray_label_off());
    }
    Ok(prefs)
}

/// One background check: publish a result, or relabel the tray on failure.
async fn run_check(app: &AppHandle) {
    match fetch_app_update(app).await {
        Ok(update) => publish(app, &update),
        Err(err) => {
            // Offline / rate-limited is routine — info, not warn, so it doesn't pollute the
            // warn+error default view of the logs pane.
            log::info("update", "background update check failed")
                .field("error", &err)
                .emit();
            set_tray(app, &tray_label(Err(&err)));
        }
    }
}

/// Register the managed state and start the background poll. Called once from `setup`; the tray
/// item is attached separately (`set_tray_item`) once main.rs has built the menu. The poll is a
/// no-op tick while the `update_check` preference is off (re-read every tick, so a toggle in the
/// studio takes effect without a restart).
pub fn init(app: AppHandle) {
    app.manage(UpdateState::default());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            if load_prefs(&app).update_check {
                run_check(&app).await;
            } else {
                set_tray(&app, &tray_label_off());
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/// The tray item's label while background checks are off (the item is inert; it can't be hidden).
pub fn tray_label_off() -> TrayLabel {
    TrayLabel {
        text: "Update checks off (Settings → About)".to_string(),
        enabled: false,
    }
}

/// Attach the tray menu item the checker relabels (built by main.rs after `init`).
pub fn set_tray_item(app: &AppHandle, item: MenuItem<Wry>) {
    if let Some(state) = app.try_state::<UpdateState>()
        && let Ok(mut slot) = state.tray_item.lock()
    {
        *slot = Some(item);
    }
}

/// Record a successful check: store it, notify every webview, and relabel the tray item. Also the
/// sink for the manual About-panel check so both paths keep one source of truth.
pub fn publish(app: &AppHandle, update: &AppUpdate) {
    if let Some(state) = app.try_state::<UpdateState>()
        && let Ok(mut latest) = state.latest.lock()
    {
        *latest = Some(update.clone());
    }
    if update.update_available {
        log::info("update", "newer release available")
            .field("current", &update.current)
            .field("latest", &update.latest)
            .emit();
    }
    let _ = app.emit(APP_UPDATE_EVENT, update);
    set_tray(app, &tray_label(Ok(update)));
}

fn set_tray(app: &AppHandle, label: &TrayLabel) {
    if let Some(state) = app.try_state::<UpdateState>()
        && let Ok(slot) = state.tray_item.lock()
        && let Some(item) = slot.as_ref()
    {
        let _ = item.set_text(&label.text);
        let _ = item.set_enabled(label.enabled);
    }
}

/// What the tray's update item should read + whether it is clickable. Tauri menu items can't be
/// hidden, so an up-to-date / unknown state is shown disabled with a status label instead.
#[derive(Debug, PartialEq, Eq)]
pub struct TrayLabel {
    pub text: String,
    pub enabled: bool,
}

/// Pure seam: the tray item for a check outcome (`Ok` = a completed check, `Err` = the failure text).
pub fn tray_label(outcome: Result<&AppUpdate, &str>) -> TrayLabel {
    match outcome {
        Ok(u) if u.update_available => TrayLabel {
            text: format!("Update available: v{}", u.latest),
            enabled: true,
        },
        Ok(u) => TrayLabel {
            text: format!("Up to date (v{})", u.current),
            enabled: false,
        },
        Err(_) => TrayLabel {
            text: "Update check failed".to_string(),
            enabled: false,
        },
    }
}

/// Pure seam: whether `url` may be handed to the shell — https, on github.com, under this repo.
pub fn url_allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix(ALLOWED_URL_PREFIX) else {
        return false;
    };
    // Exactly the repo root, or a path/query/fragment under it — never a sibling like
    // `widgetsack-evil` or a userinfo/host trick (the prefix already pins scheme + host).
    (rest.is_empty() || rest.starts_with(['/', '?', '#']))
        && !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// The last successful background/manual check, or `None` before the first one completes — the
/// studio reads this on mount so the About tab + nav badge don't wait for the next event.
#[tauri::command]
pub fn get_app_update(state: tauri::State<'_, UpdateState>) -> Option<AppUpdate> {
    state.latest.lock().ok().and_then(|l| l.clone())
}

/// Tray click: open the release page of the last known update (no-op when none is known).
pub fn open_release_page(app: &AppHandle) {
    let url = app
        .try_state::<UpdateState>()
        .and_then(|s| s.latest.lock().ok().and_then(|l| l.clone()))
        .filter(|u| u.update_available)
        .map(|u| u.url);
    if let Some(url) = url
        && let Err(err) = open_url_impl(&url)
    {
        log::warn("update", "failed to open release page")
            .field("error", err)
            .emit();
    }
}

/// Open a project release page in the default browser (ShellExecuteW). Refuses anything that isn't
/// an https URL under github.com/gyng/widgetsack — the value comes from the network, not the user.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    open_url_impl(&url)
}

fn open_url_impl(url: &str) -> Result<(), String> {
    if !url_allowed(url) {
        return Err(format!("refusing to open non-project URL: {url}"));
    }
    shell_open(url)
}

#[cfg(target_os = "windows")]
fn shell_open(url: &str) -> Result<(), String> {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::{HSTRING, w};
    let target = HSTRING::from(url);
    // SAFETY: plain FFI with valid, NUL-terminated wide strings that outlive the call; no window
    // handle (None) so the shell picks the default browser.
    let h = unsafe { ShellExecuteW(None, w!("open"), &target, None, None, SW_SHOWNORMAL) };
    // ShellExecuteW returns a pseudo-HINSTANCE: > 32 means success, ≤ 32 is an error code.
    if h.0 as usize > 32 {
        Ok(())
    } else {
        Err(format!("ShellExecuteW failed (code {})", h.0 as usize))
    }
}

#[cfg(not(target_os = "windows"))]
fn shell_open(_url: &str) -> Result<(), String> {
    Err("opening URLs is only supported on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        AppPrefs, AppUpdate, TrayLabel, parse_prefs, tray_label, tray_label_off, url_allowed,
    };

    fn update(available: bool) -> AppUpdate {
        AppUpdate {
            current: "0.0.55".into(),
            latest: "0.0.56".into(),
            url: "https://github.com/gyng/widgetsack/releases/tag/v0.0.56".into(),
            update_available: available,
        }
    }

    #[test]
    fn prefs_default_to_no_background_update_check() {
        // Opt-in: an absent/empty/garbage prefs file must NOT start polling GitHub.
        assert_eq!(parse_prefs(""), AppPrefs::default());
        assert_eq!(parse_prefs("{}"), AppPrefs::default());
        assert_eq!(parse_prefs("not json"), AppPrefs::default());
        assert!(!AppPrefs::default().update_check);
        assert!(parse_prefs(r#"{"update_check":true}"#).update_check);
        // Unknown fields (a newer build's prefs) are ignored, not fatal.
        assert!(parse_prefs(r#"{"update_check":true,"future":1}"#).update_check);
        assert!(!tray_label_off().enabled);
    }

    #[test]
    fn tray_label_reflects_each_outcome() {
        assert_eq!(
            tray_label(Ok(&update(true))),
            TrayLabel {
                text: "Update available: v0.0.56".into(),
                enabled: true
            }
        );
        assert_eq!(
            tray_label(Ok(&update(false))),
            TrayLabel {
                text: "Up to date (v0.0.55)".into(),
                enabled: false
            }
        );
        let failed = tray_label(Err("offline"));
        assert!(!failed.enabled);
        assert_eq!(failed.text, "Update check failed");
    }

    #[test]
    fn url_allowed_pins_scheme_host_and_repo() {
        assert!(url_allowed("https://github.com/gyng/widgetsack"));
        assert!(url_allowed(
            "https://github.com/gyng/widgetsack/releases/tag/v0.0.56"
        ));
        assert!(url_allowed("https://github.com/gyng/widgetsack?tab=readme"));
        // Wrong scheme / host / repo / a look-alike sibling / embedded whitespace.
        assert!(!url_allowed("http://github.com/gyng/widgetsack/releases"));
        assert!(!url_allowed(
            "https://github.com.evil.example/gyng/widgetsack"
        ));
        assert!(!url_allowed(
            "https://github.com/gyng/widgetsack-evil/releases"
        ));
        assert!(!url_allowed("https://github.com/other/widgetsack"));
        assert!(!url_allowed("https://github.com/gyng/widgetsack/x y"));
        assert!(!url_allowed("https://github.com/gyng/widgetsack/\n"));
        assert!(!url_allowed(""));
    }
}
