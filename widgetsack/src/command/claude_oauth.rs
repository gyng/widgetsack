//! Keep a Claude Code profile's OAuth access token usable for the usage endpoint.
//!
//! The CLI renews its access token only while it runs, so a profile that hasn't been used for a
//! few hours has an expired token. When that happens we refresh it the way the CLI does and write
//! the new token pair back to that profile's `.credentials.json`, which a running CLI notices by
//! mtime and reloads.
//!
//! Refresh tokens rotate, so two processes refreshing at once can strand one of them. We take the
//! same directory locks the CLI takes (`<config>/.oauth_refresh.lock` and the legacy
//! `<config>.lock`; created with `mkdir`, stale after 60 s), then re-read the credentials inside
//! the lock and skip the refresh if another process already renewed them.
//! Tokens never leave Rust and are never logged.
use serde_json::{Value, json};
use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
/// Claude Code's public OAuth client ID.
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// Refresh a little early so a token can't expire between reading it and using it.
const EXPIRY_MARGIN_MS: u64 = 5 * 60 * 1000;
/// Matches the CLI's lock staleness, after which a holder is assumed dead.
const LOCK_STALE: Duration = Duration::from_secs(60);
const LOCK_WAIT: Duration = Duration::from_secs(10);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Whether the stored access token is missing, expired, or about to expire.
fn needs_refresh(oauth: &Value, now: u64) -> bool {
    oauth["accessToken"].as_str().is_none_or(str::is_empty)
        || oauth["expiresAt"]
            .as_u64()
            .is_none_or(|at| at <= now + EXPIRY_MARGIN_MS)
}

fn refresh_body(oauth: &Value) -> Result<Value, String> {
    let token = oauth["refreshToken"]
        .as_str()
        .filter(|t| !t.is_empty())
        .ok_or("Claude login expired. Sign in to Claude Code again.")?;
    let scope = oauth["scopes"]
        .as_array()
        .map(|s| {
            s.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    Ok(json!({
        "grant_type": "refresh_token",
        "refresh_token": token,
        "client_id": CLIENT_ID,
        "scope": scope,
    }))
}

/// Fold a token-endpoint response into the stored credentials, mirroring the CLI: the refresh
/// token is kept when none is returned, and other fields (subscription, tier) are preserved.
fn apply_refresh(oauth: &mut Value, response: &Value, now: u64) -> Result<(), String> {
    let access = response["access_token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .ok_or("Claude token refresh returned no access token")?;
    let expires_in = response["expires_in"]
        .as_u64()
        .ok_or("Claude token refresh returned no expiry")?;
    oauth["accessToken"] = json!(access);
    if let Some(refresh) = response["refresh_token"].as_str().filter(|t| !t.is_empty()) {
        oauth["refreshToken"] = json!(refresh);
    }
    oauth["expiresAt"] = json!(now + expires_in * 1000);
    if let Some(secs) = response["refresh_token_expires_in"].as_u64() {
        oauth["refreshTokenExpiresAt"] = json!(now + secs * 1000);
    }
    if let Some(scope) = response["scope"].as_str() {
        let scopes: Vec<&str> = scope.split(' ').filter(|s| !s.is_empty()).collect();
        if !scopes.is_empty() {
            oauth["scopes"] = json!(scopes);
        }
    }
    Ok(())
}

/// A `mkdir` lock compatible with the CLI's lockfile library. Removed on drop.
struct DirLock(PathBuf);
impl DirLock {
    fn try_acquire(path: &Path) -> std::io::Result<Option<Self>> {
        match std::fs::create_dir(path) {
            Ok(()) => Ok(Some(Self(path.to_path_buf()))),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                let stale = std::fs::metadata(path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|m| m.elapsed().ok())
                    .is_some_and(|age| age > LOCK_STALE);
                if stale && std::fs::remove_dir(path).is_ok() {
                    return Self::try_acquire_fresh(path);
                }
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }
    fn try_acquire_fresh(path: &Path) -> std::io::Result<Option<Self>> {
        match std::fs::create_dir(path) {
            Ok(()) => Ok(Some(Self(path.to_path_buf()))),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok(None),
            Err(e) => Err(e),
        }
    }
}
impl Drop for DirLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.0);
    }
}

fn legacy_lock_path(dir: &Path) -> PathBuf {
    let mut path = dir.as_os_str().to_owned();
    path.push(".lock");
    PathBuf::from(path)
}

/// Both CLI locks, or `None` if either is held by a live process.
fn try_lock_profile(dir: &Path) -> std::io::Result<Option<(DirLock, DirLock)>> {
    let Some(new) = DirLock::try_acquire(&dir.join(".oauth_refresh.lock"))? else {
        return Ok(None);
    };
    Ok(DirLock::try_acquire(&legacy_lock_path(dir))?.map(|legacy| (new, legacy)))
}

async fn lock_profile(dir: &Path) -> Result<(DirLock, DirLock), String> {
    let deadline = tokio::time::Instant::now() + LOCK_WAIT;
    loop {
        let attempt = {
            let dir = dir.to_path_buf();
            tokio::task::spawn_blocking(move || try_lock_profile(&dir))
                .await
                .map_err(|_| "Claude token lock stopped".to_string())?
                .map_err(|_| "Cannot lock Claude credentials".to_string())?
        };
        if let Some(locks) = attempt {
            return Ok(locks);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("Claude Code is refreshing this login; retrying later".into());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn read_credentials(path: &Path) -> Result<Value, String> {
    let raw = tokio::fs::read(path)
        .await
        .map_err(|_| "Claude CLI credentials unavailable. Sign in to Claude Code.".to_string())?;
    serde_json::from_slice(&raw).map_err(|_| "Invalid Claude credentials file".to_string())
}

/// Replace the file atomically so a reader never sees a partial write.
async fn write_credentials(path: &Path, credentials: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(credentials).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.widgetsack-tmp");
    tokio::fs::write(&temp, body)
        .await
        .map_err(|_| "Cannot save refreshed Claude login".to_string())?;
    tokio::fs::rename(&temp, path).await.map_err(|_| {
        let _ = std::fs::remove_file(&temp);
        "Cannot save refreshed Claude login".to_string()
    })
}

async fn post_refresh(body: &Value) -> Result<Value, String> {
    let client = super::http::install_http_client()?;
    let response = client
        .post(TOKEN_URL)
        .json(body)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| "Claude token refresh request failed".to_string())?;
    let status = response.status();
    if status == reqwest::StatusCode::BAD_REQUEST || status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Claude login expired. Sign in to Claude Code again.".into());
    }
    if !status.is_success() {
        return Err(format!("Claude token refresh returned HTTP {status}"));
    }
    let raw = super::http::read_body_capped(response).await?;
    serde_json::from_slice(&raw).map_err(|_| "Claude token refresh returned invalid JSON".into())
}

/// A usable access token for the Claude Code profile in `dir`, refreshing it when it has
/// expired. `force` refreshes even if the stored expiry looks fine (after a 401).
pub(super) async fn access_token(dir: &Path, force: bool) -> Result<String, String> {
    let path = dir.join(".credentials.json");
    let credentials = read_credentials(&path).await?;
    let oauth = &credentials["claudeAiOauth"];
    if !oauth.is_object() {
        return Err("Claude subscription login not found".into());
    }
    let seen = oauth["accessToken"].as_str().unwrap_or("").to_string();
    if !force && !needs_refresh(oauth, now_ms()) {
        return Ok(seen);
    }

    let _locks = lock_profile(dir).await?;
    // Another process may have refreshed while we waited for the lock.
    let mut credentials = read_credentials(&path).await?;
    let oauth = &credentials["claudeAiOauth"];
    let current = oauth["accessToken"].as_str().unwrap_or("");
    if current != seen && !needs_refresh(oauth, now_ms()) {
        return Ok(current.to_string());
    }
    let response = post_refresh(&refresh_body(oauth)?).await?;
    apply_refresh(&mut credentials["claudeAiOauth"], &response, now_ms())?;
    write_credentials(&path, &credentials).await?;
    crate::log::info("ai-usage", "claude login refreshed").emit();
    Ok(credentials["claudeAiOauth"]["accessToken"]
        .as_str()
        .unwrap_or_default()
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refreshes_only_missing_expired_or_nearly_expired_tokens() {
        let now = 1_000_000_000;
        let valid = json!({"accessToken":"a","expiresAt": now + EXPIRY_MARGIN_MS + 1});
        assert!(!needs_refresh(&valid, now));
        for oauth in [
            json!({"accessToken":"a","expiresAt": now + EXPIRY_MARGIN_MS}),
            json!({"accessToken":"a","expiresAt": now - 1}),
            json!({"accessToken":"a"}),
            json!({"accessToken":"","expiresAt": now * 2}),
            json!({"expiresAt": now * 2}),
        ] {
            assert!(needs_refresh(&oauth, now), "{oauth}");
        }
    }

    #[test]
    fn refresh_request_matches_the_cli() {
        let oauth = json!({"refreshToken":"r","scopes":["user:inference","user:profile"]});
        assert_eq!(
            refresh_body(&oauth).unwrap(),
            json!({
                "grant_type":"refresh_token",
                "refresh_token":"r",
                "client_id": CLIENT_ID,
                "scope":"user:inference user:profile"
            })
        );
        assert!(refresh_body(&json!({"refreshToken":""})).is_err());
        assert!(refresh_body(&json!({})).is_err());
    }

    #[test]
    fn applied_refresh_rotates_tokens_and_keeps_other_fields() {
        let now = 1_000;
        let mut oauth = json!({
            "accessToken":"old","refreshToken":"r1","expiresAt":1,
            "scopes":["user:inference"],"subscriptionType":"max","rateLimitTier":"t"
        });
        apply_refresh(
            &mut oauth,
            &json!({"access_token":"new","refresh_token":"r2","expires_in":3600,
                    "refresh_token_expires_in":60,"scope":"user:inference user:profile"}),
            now,
        )
        .unwrap();
        assert_eq!(
            oauth,
            json!({
                "accessToken":"new","refreshToken":"r2","expiresAt": now + 3_600_000,
                "refreshTokenExpiresAt": now + 60_000,
                "scopes":["user:inference","user:profile"],
                "subscriptionType":"max","rateLimitTier":"t"
            })
        );
        // No rotated refresh token or scope: keep the stored ones.
        apply_refresh(
            &mut oauth,
            &json!({"access_token":"newer","expires_in":10}),
            now,
        )
        .unwrap();
        assert_eq!(oauth["refreshToken"], "r2");
        assert_eq!(oauth["scopes"], json!(["user:inference", "user:profile"]));
        assert!(apply_refresh(&mut oauth, &json!({"expires_in":10}), now).is_err());
        assert!(apply_refresh(&mut oauth, &json!({"access_token":"x"}), now).is_err());
    }

    #[test]
    fn profile_locks_exclude_each_other_and_release_on_drop() {
        let dir =
            std::env::temp_dir().join(format!("widgetsack-claude-lock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let held = try_lock_profile(&dir).unwrap().expect("first lock");
        assert!(dir.join(".oauth_refresh.lock").is_dir());
        assert!(legacy_lock_path(&dir).is_dir());
        assert!(try_lock_profile(&dir).unwrap().is_none());
        drop(held);
        assert!(!dir.join(".oauth_refresh.lock").exists());
        assert!(!legacy_lock_path(&dir).exists());

        // A live legacy lock (another CLI) blocks us and doesn't leave our new lock behind.
        std::fs::create_dir(legacy_lock_path(&dir)).unwrap();
        assert!(try_lock_profile(&dir).unwrap().is_none());
        assert!(!dir.join(".oauth_refresh.lock").exists());
        std::fs::remove_dir(legacy_lock_path(&dir)).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn legacy_lock_sits_beside_the_profile_directory() {
        assert_eq!(
            legacy_lock_path(Path::new(r"C:\Users\me\.claude-1")),
            PathBuf::from(r"C:\Users\me\.claude-1.lock")
        );
    }
}
