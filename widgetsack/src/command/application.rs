use super::http::{install_http_client, read_body_capped};
use serde::Serialize;

/// GitHub releases API for the app's own repo — the manual "check for updates" source (the app
/// ships no auto-updater, so this just tells the user a newer release exists).
const GITHUB_LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/gyng/widgetsack/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/gyng/widgetsack/releases";

#[derive(Clone, Debug, Serialize)]
pub struct AppUpdate {
    pub current: String,
    pub latest: String,
    pub url: String,
    pub update_available: bool,
}

/// Parse an `X.Y.Z` version into a comparable tuple, tolerating a leading `v` and a `-pre`/`+build`
/// suffix; any missing or non-numeric part is 0 so a malformed tag never falsely reports an update.
fn parse_version(v: &str) -> (u32, u32, u32) {
    let core = v.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next().unwrap_or(core);
    let mut parts = core.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

/// Whether `latest` is a newer version than `current` (numeric X.Y.Z compare). Pure seam.
fn version_is_newer(latest: &str, current: &str) -> bool {
    parse_version(latest) > parse_version(current)
}

/// Whether a GitHub API response means "you are rate-limited" rather than a real failure: an
/// unauthenticated client gets HTTP 403 (or 429) with `x-ratelimit-remaining: 0`. Pure seam.
fn github_rate_limited(status: u16, ratelimit_remaining: Option<&str>) -> bool {
    matches!(status, 403 | 429) && ratelimit_remaining.map(str::trim) == Some("0")
}

/// Fold the latest-release JSON into an `AppUpdate` against `current`. Pure seam: the tag is
/// compared numerically (a `v` prefix is tolerated), and a missing `html_url` falls back to the
/// releases page so the "open release" affordance always has somewhere to go.
fn app_update_from_release(json: &serde_json::Value, current: &str) -> Result<AppUpdate, String> {
    let latest = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or("update check failed: no tag_name in latest release")?
        .trim_start_matches('v')
        .to_string();
    let url = json
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or(RELEASES_PAGE)
        .to_string();
    let update_available = version_is_newer(&latest, current);
    Ok(AppUpdate {
        current: current.to_string(),
        latest,
        url,
        update_available,
    })
}

/// Ask GitHub for the latest published release of the app and compare it to the running version.
/// Shared by the manual About-panel check (`check_app_update`) and the background checker
/// (update.rs). Best-effort — any network/parse failure is an `Err` the UI shows verbatim. The
/// GitHub REST API requires a User-Agent (so the plain `fetch_text_capped` client can't be reused
/// as-is); the body is still read under the same `FETCH_CAP` so a hostile response can't balloon.
pub async fn fetch_app_update(app: &tauri::AppHandle) -> Result<AppUpdate, String> {
    let current = app.package_info().version.to_string();
    let client = install_http_client()?;
    let resp = client
        .get(GITHUB_LATEST_RELEASE_API)
        .header(reqwest::header::USER_AGENT, "widgetsack")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let remaining = resp
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|v| v.to_str().ok());
        if github_rate_limited(status.as_u16(), remaining) {
            return Err("GitHub rate limit hit, try again later".to_string());
        }
        return Err(format!("update check failed: HTTP {status}"));
    }
    let buf = read_body_capped(resp)
        .await
        .map_err(|e| format!("update check failed: {e}"))?;
    let json: serde_json::Value =
        serde_json::from_slice(&buf).map_err(|e| format!("update check failed: {e}"))?;
    app_update_from_release(&json, &current)
}

/// Manual "check for updates" (the About panel button). Also feeds the result to the background
/// checker's state + tray item (update.rs) so the studio badge / tray label reflect it right away.
#[tauri::command]
pub async fn check_app_update(app: tauri::AppHandle) -> Result<AppUpdate, String> {
    let update = fetch_app_update(&app).await?;
    crate::update::publish(&app, &update);
    Ok(update)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_newer_compares_numerically() {
        assert!(version_is_newer("0.0.42", "0.0.41"));
        assert!(version_is_newer("0.1.0", "0.0.41")); // 0.1.0 > 0.0.41, not string compare
        assert!(version_is_newer("1.0.0", "0.9.9"));
        assert!(!version_is_newer("0.0.41", "0.0.41")); // equal → no update
        assert!(!version_is_newer("0.0.40", "0.0.41")); // older
    }

    #[test]
    fn version_is_newer_tolerates_v_prefix_and_suffixes() {
        assert!(version_is_newer("v0.0.42", "0.0.41"));
        assert!(!version_is_newer("0.0.41-rc1", "0.0.41")); // pre-release suffix stripped → equal
        assert!(!version_is_newer("garbage", "0.0.1")); // unparseable → (0,0,0), no false update
    }

    #[test]
    fn github_rate_limited_needs_both_status_and_exhausted_quota() {
        use super::github_rate_limited;
        assert!(github_rate_limited(403, Some("0")));
        assert!(github_rate_limited(429, Some(" 0 ")));
        assert!(!github_rate_limited(403, Some("57"))); // a real 403 (not quota)
        assert!(!github_rate_limited(403, None));
        assert!(!github_rate_limited(500, Some("0"))); // outage, not rate limiting
    }

    #[test]
    fn app_update_from_release_folds_tag_and_url() {
        use super::app_update_from_release;
        let json = serde_json::json!({
            "tag_name": "v0.0.56",
            "html_url": "https://github.com/gyng/widgetsack/releases/tag/v0.0.56"
        });
        let u = app_update_from_release(&json, "0.0.55").unwrap();
        assert_eq!(u.current, "0.0.55");
        assert_eq!(u.latest, "0.0.56"); // v-prefix stripped for display
        assert!(u.update_available);
        assert!(u.url.ends_with("/tag/v0.0.56"));
        // Same version → no update; a missing html_url falls back to the releases page.
        let json = serde_json::json!({ "tag_name": "0.0.55" });
        let u = app_update_from_release(&json, "0.0.55").unwrap();
        assert!(!u.update_available);
        assert_eq!(u.url, super::RELEASES_PAGE);
        // No tag → a clear error (not a false "up to date").
        assert!(app_update_from_release(&serde_json::json!({}), "0.0.55").is_err());
    }
}
