use super::http::{FETCH_CAP, fetch_text_capped, install_http_client};
use crate::file_io::{atomic_write, config_root, valid_name};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

// The app-config `plugins/` dir already holds first-party config FILES (ha.json, llm.json, …);
// a third-party package is a SUBDIRECTORY containing a `plugin.json`, so the two coexist
// unambiguously — only directories with a manifest are listed. Dumb I/O only: the frontend
// parses/validates the manifest (core/pluginPackage.ts) and decides what to register.

fn plugins_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = config_root(app)?;
    Ok(dir.join("plugins"))
}

/// A package asset filename is a single path component: `<valid_name stem>.<css|json|js>` (`.js`
/// is a Phase 2 sandboxed source script — it is only ever TEXT to the backend). Splitting at the
/// LAST dot and running the stem through `valid_name` rejects separators, `..`, extra dots
/// (so no `x.css.tmp` smuggling), and oversized names by construction.
fn valid_asset_name(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((stem, ext)) => {
            (ext.eq_ignore_ascii_case("css")
                || ext.eq_ignore_ascii_case("json")
                || ext.eq_ignore_ascii_case("js"))
                && valid_name(stem)
        }
        None => false,
    }
}

#[derive(Serialize)]
pub struct PluginPackageFile {
    /// The package directory name (its id; the frontend cross-checks the manifest's `id`).
    pub id: String,
    /// Raw `plugin.json` contents, unparsed.
    pub manifest: String,
    /// Raw `.install.json` sidecar (written by `install_plugin_package`), unparsed — the frontend
    /// parses it (core/pluginPackage.ts `parseInstallSidecar`) to show provenance and drive the
    /// update-check/update affordances. `None` for hand-dropped (local) packages.
    pub install: Option<String>,
}

/// Every `plugins/<id>/plugin.json`, sorted by id. Directories only (first-party config FILES in
/// `plugins/` are skipped), ids must pass `valid_name` (they become path segments in
/// `read_plugin_package_asset`). Missing `plugins/` dir → empty vec.
#[tauri::command]
pub fn list_plugin_packages(app: tauri::AppHandle) -> Result<Vec<PluginPackageFile>, String> {
    let dir = plugins_dir(&app)?;
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(id) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !valid_name(id) {
                continue;
            }
            if let Ok(manifest) = fs::read_to_string(path.join("plugin.json")) {
                out.push(PluginPackageFile {
                    id: id.to_string(),
                    manifest,
                    install: fs::read_to_string(path.join(INSTALL_SIDECAR)).ok(),
                });
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Read `plugins/<id>/<name>` — a manifest-declared asset (theme CSS / extra JSON). Both segments
/// are sanitized (no traversal); only `.css`/`.json` files are readable. `None` if absent.
#[tauri::command]
pub fn read_plugin_package_asset(
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<Option<String>, String> {
    if !valid_name(&id) {
        return Err("invalid package id".to_string());
    }
    if !valid_asset_name(&name) {
        return Err("invalid asset name".to_string());
    }
    let path = plugins_dir(&app)?.join(&id).join(&name);
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

// ---- plugin packages: remote install (Phase 3) -------------------------------------------------
// Install a package straight from a GitHub link (or any https URL to a plugin.json): fetch the
// manifest + its declared assets over https (10s timeout, 256 KiB per-file cap), write them into
// `plugins/<id>/` via atomic_write, and record provenance in a `.install.json` sidecar so the
// frontend can offer MANUAL update checks later. Validation stays split exactly like Phase 1: the
// backend only enforces the path-safety invariants (`valid_name` id, `valid_asset_name` assets);
// the frontend does the full structural validation and the enable/consent gate — a freshly
// installed package lands DISABLED like a hand-dropped folder.

/// Provenance sidecar filename. Starts with a dot so its stem fails `valid_name`, which keeps it
/// out of `read_plugin_package_asset`'s reachable set and out of any manifest's declarable assets.
const INSTALL_SIDECAR: &str = ".install.json";

/// A resolved install source: where the manifest lives, plus what the sidecar should record.
#[derive(Debug, PartialEq)]
struct ResolvedSource {
    /// Direct https URL of the `plugin.json` to GET.
    manifest_url: String,
    /// What the sidecar stores as `source`: `owner/repo` for GitHub forms, the URL itself for
    /// direct links. Paired with `reff`, it's enough to re-derive `manifest_url` at update time.
    display_source: String,
    /// Git ref for GitHub forms (`main` unless a `/tree/<ref>` URL pinned one); `direct` for a
    /// verbatim plugin.json URL.
    reff: String,
}

/// One GitHub owner/repo path segment: ASCII alphanumeric plus `-`/`_`/`.`, no `..`, bounded.
fn gh_token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && !s.contains("..")
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// A git ref as it may appear in a `/tree/<ref>` URL: like `gh_token` but slashes are allowed
/// (branch names such as `feature/x`), `..` still rejected.
fn valid_ref(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && !s.contains("..")
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '/')
}

fn raw_manifest_url(owner: &str, repo: &str, reff: &str) -> String {
    format!("https://raw.githubusercontent.com/{owner}/{repo}/{reff}/plugin.json")
}

/// PURE SEAM: turn the user's install input into a manifest URL + sidecar provenance. Accepted
/// forms (anything else → `None`; plain `http://` is rejected outright — https only):
///
/// | input                                        | manifest_url                                              | ref      |
/// |----------------------------------------------|-----------------------------------------------------------|----------|
/// | `owner/repo`                                 | `https://raw.githubusercontent.com/owner/repo/main/plugin.json`  | `main`   |
/// | `https://github.com/owner/repo[/]`           | same as above                                             | `main`   |
/// | `https://github.com/owner/repo/tree/<ref>`   | `…/owner/repo/<ref>/plugin.json`                          | `<ref>`  |
/// | any https URL ending in `/plugin.json`       | used verbatim                                             | `direct` |
fn resolve_package_source(input: &str) -> Option<ResolvedSource> {
    let input = input.trim().trim_end_matches('/');
    if let Some(rest) = input.strip_prefix("https://") {
        if let Some(path) = rest.strip_prefix("github.com/") {
            // splitn(4): segment 4 keeps any remaining slashes — that's the (slash-friendly) ref.
            let parts: Vec<&str> = path.splitn(4, '/').collect();
            return match parts.as_slice() {
                [owner, repo] if gh_token(owner) && gh_token(repo) => Some(ResolvedSource {
                    manifest_url: raw_manifest_url(owner, repo, "main"),
                    display_source: format!("{owner}/{repo}"),
                    reff: "main".to_string(),
                }),
                [owner, repo, "tree", reff]
                    if gh_token(owner) && gh_token(repo) && valid_ref(reff) =>
                {
                    Some(ResolvedSource {
                        manifest_url: raw_manifest_url(owner, repo, reff),
                        display_source: format!("{owner}/{repo}"),
                        reff: reff.to_string(),
                    })
                }
                _ => None,
            };
        }
        if input.ends_with("/plugin.json") {
            return Some(ResolvedSource {
                manifest_url: input.to_string(),
                display_source: input.to_string(),
                reff: "direct".to_string(),
            });
        }
        return None;
    }
    // `owner/repo` shorthand — exactly one slash, both segments GitHub-safe, no scheme at all.
    if input.contains("://") {
        return None;
    }
    let (owner, repo) = input.split_once('/')?;
    if gh_token(owner) && gh_token(repo) && !repo.contains('/') {
        return Some(ResolvedSource {
            manifest_url: raw_manifest_url(owner, repo, "main"),
            display_source: format!("{owner}/{repo}"),
            reff: "main".to_string(),
        });
    }
    None
}

/// PURE SEAM: a declared asset lives next to its manifest — swap the URL's last segment.
fn asset_url_for(manifest_url: &str, asset_name: &str) -> String {
    match manifest_url.rsplit_once('/') {
        Some((base, _)) => format!("{base}/{asset_name}"),
        None => asset_name.to_string(),
    }
}

/// PURE SEAM: re-derive the manifest URL from sidecar provenance (`source` + `ref`) for update
/// checks / re-installs. `direct` sources re-run through `resolve_package_source` so a tampered
/// sidecar can't smuggle a non-https or non-plugin.json URL back in.
fn manifest_url_from_sidecar(source: &str, reff: &str) -> Option<String> {
    if reff == "direct" {
        let resolved = resolve_package_source(source)?;
        return (resolved.reff == "direct").then_some(resolved.manifest_url);
    }
    let (owner, repo) = source.split_once('/')?;
    if gh_token(owner) && gh_token(repo) && !repo.contains('/') && valid_ref(reff) {
        Some(raw_manifest_url(owner, repo, reff))
    } else {
        None
    }
}

#[derive(Serialize)]
pub struct InstalledPackage {
    pub id: String,
    pub version: String,
}

fn plugin_install_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn package_sibling_path(root: &Path, id: &str, kind: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);
    let seq = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
    root.join(format!(".{id}.{kind}-{}-{seq}", std::process::id()))
}

/// Build a complete package in an invisible sibling directory, then swap it into place. The target
/// remains byte-for-byte untouched if any staged write fails; updates also remove stale old assets.
fn install_package_directory_with(
    root: &Path,
    id: &str,
    manifest: &str,
    assets: &[(String, String)],
    sidecar: &str,
    replace: bool,
    mut write_file: impl FnMut(&Path, &str) -> Result<(), String>,
) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let target = root.join(id);
    if target.exists() != replace {
        return Err(if replace {
            format!("package \"{id}\" is no longer installed")
        } else {
            format!("package id \"{id}\" is already installed")
        });
    }

    let stage = package_sibling_path(root, id, "stage");
    fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let staged = (|| {
        write_file(&stage.join("plugin.json"), manifest)?;
        for (name, body) in assets {
            write_file(&stage.join(name), body)?;
        }
        write_file(&stage.join(INSTALL_SIDECAR), sidecar)
    })();
    if let Err(err) = staged {
        let _ = fs::remove_dir_all(&stage);
        return Err(err);
    }

    if !replace {
        return fs::rename(&stage, &target).map_err(|err| {
            let _ = fs::remove_dir_all(&stage);
            err.to_string()
        });
    }

    let backup = package_sibling_path(root, id, "backup");
    fs::rename(&target, &backup).map_err(|err| {
        let _ = fs::remove_dir_all(&stage);
        err.to_string()
    })?;
    if let Err(err) = fs::rename(&stage, &target) {
        let rollback = fs::rename(&backup, &target);
        let _ = fs::remove_dir_all(&stage);
        return match rollback {
            Ok(()) => Err(err.to_string()),
            Err(rollback_err) => Err(format!(
                "package swap failed ({err}); rollback also failed ({rollback_err})"
            )),
        };
    }
    if let Err(err) = fs::remove_dir_all(&backup) {
        eprintln!("installed package {id}, but failed to remove its backup: {err}");
    }
    Ok(())
}

fn install_package_directory(
    root: &Path,
    id: &str,
    manifest: &str,
    assets: &[(String, String)],
    sidecar: &str,
    replace: bool,
) -> Result<(), String> {
    install_package_directory_with(
        root,
        id,
        manifest,
        assets,
        sidecar,
        replace,
        |path, body| fs::write(path, body).map_err(|e| e.to_string()),
    )
}

/// Install a package from `source` (see `resolve_package_source` for accepted forms). `replace_id`
/// is required for an update and must match the downloaded manifest; without it, an existing id is
/// never overwritten. All declared assets are fetched before a complete staged directory is swapped
/// into place, so download/write failures cannot leave a half-installed package.
#[tauri::command]
pub async fn install_plugin_package(
    app: tauri::AppHandle,
    source: String,
    replace_id: Option<String>,
) -> Result<InstalledPackage, String> {
    let resolved = resolve_package_source(&source).ok_or_else(|| {
        "unrecognized source — use owner/repo, a github.com repo URL, or an https URL ending in /plugin.json"
            .to_string()
    })?;
    let client = install_http_client()?;
    let manifest_text = fetch_text_capped(client, &resolved.manifest_url).await?;
    let json: serde_json::Value = serde_json::from_str(&manifest_text)
        .map_err(|_| "downloaded plugin.json is not valid JSON".to_string())?;
    let id = json
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if !valid_name(&id) {
        return Err("manifest \"id\" is missing or not a safe folder name".to_string());
    }
    if let Some(expected) = &replace_id
        && (!valid_name(expected) || expected != &id)
    {
        return Err(format!(
            "update expected package id \"{expected}\", but manifest declares \"{id}\""
        ));
    }
    let version = json
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if version.is_empty() {
        return Err("manifest has no \"version\"".to_string());
    }
    // Declared assets: `theme.file` (Phase 1) and `source.file` (Phase 2 sandbox script) are the
    // only asset slots in manifestVersion 1. Fetch before writing anything.
    let mut assets: Vec<(String, String)> = Vec::new();
    for pointer in ["/theme/file", "/source/file"] {
        if let Some(file) = json.pointer(pointer).and_then(|v| v.as_str()) {
            if !valid_asset_name(file) {
                return Err(format!("declared asset \"{file}\" has an unsafe filename"));
            }
            let body =
                fetch_text_capped(client, &asset_url_for(&resolved.manifest_url, file)).await?;
            assets.push((file.to_string(), body));
        }
    }
    let installed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let sidecar = serde_json::json!({
        "source": resolved.display_source,
        "ref": resolved.reff,
        "version": version,
        "installedAt": installed_at,
    });
    let _guard = plugin_install_lock().lock().await;
    install_package_directory(
        &plugins_dir(&app)?,
        &id,
        &manifest_text,
        &assets,
        &sidecar.to_string(),
        replace_id.is_some(),
    )?;
    Ok(InstalledPackage { id, version })
}

#[derive(Serialize)]
pub struct UpdateCheck {
    pub current: String,
    pub latest: String,
    pub source: String,
}

/// MANUAL update check for an installed package: re-fetch just the manifest from the sidecar's
/// recorded source and report both versions (the frontend compares — any difference counts as
/// "update available"; downgrades are deliberate re-installs). Packages without a sidecar
/// (hand-dropped folders) have nowhere to check against.
#[tauri::command]
pub async fn check_plugin_package_update(
    app: tauri::AppHandle,
    id: String,
) -> Result<UpdateCheck, String> {
    if !valid_name(&id) {
        return Err("invalid package id".to_string());
    }
    let raw = fs::read_to_string(plugins_dir(&app)?.join(&id).join(INSTALL_SIDECAR))
        .map_err(|_| "package was not installed from a URL".to_string())?;
    let side: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "install record is corrupt".to_string())?;
    let source = side
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let reff = side.get("ref").and_then(|v| v.as_str()).unwrap_or("main");
    let current = side
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let url = manifest_url_from_sidecar(&source, reff)
        .ok_or_else(|| "install record has an invalid source".to_string())?;
    let client = install_http_client()?;
    let manifest_text = fetch_text_capped(client, &url).await?;
    let json: serde_json::Value = serde_json::from_str(&manifest_text)
        .map_err(|_| "remote plugin.json is not valid JSON".to_string())?;
    let latest = json
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if latest.is_empty() {
        return Err("remote manifest has no \"version\"".to_string());
    }
    Ok(UpdateCheck {
        current,
        latest,
        source,
    })
}

/// Delete `plugins/<id>/` (works for installed AND hand-dropped packages — it's just a dir
/// delete). Ok even if it's already gone (idempotent, like the other deletes here).
#[tauri::command]
pub async fn remove_plugin_package(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !valid_name(&id) {
        return Err("invalid package id".to_string());
    }
    let _guard = plugin_install_lock().lock().await;
    match fs::remove_dir_all(plugins_dir(&app)?.join(&id)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

// ---- plugin packages: sandboxed source network proxy (Phase 2) ----------------------------------
// A package's `source.js` runs in a QuickJS sandbox with ZERO capabilities; the frontend asks this
// command to perform each fetch between the sandbox's two pure calls. The hosts allowlist is
// re-read from the manifest ON DISK per request (server-side enforcement — a compromised webview
// can't widen it), https only, GET only, redirects DISABLED (so the response host can never drift
// off-allowlist), 10s timeout, 256 KiB body cap.

/// PURE SEAM: is `url` an https URL whose host is a DOMAIN matching one of `hosts` exactly?
/// Subdomains must be listed explicitly; IP literals, explicit ports, embedded credentials, and
/// non-https schemes all fail. Comparison is ASCII-case-insensitive (URL hosts parse lowercased,
/// but the manifest on disk is untrusted text).
fn host_allowed(url: &str, hosts: &[String]) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else {
        return false;
    };
    if u.scheme() != "https" || u.port().is_some() {
        return false;
    }
    if !u.username().is_empty() || u.password().is_some() {
        return false;
    }
    match u.domain() {
        Some(d) => hosts.iter().any(|h| h.eq_ignore_ascii_case(d)),
        None => false, // IP literal (or no host at all)
    }
}

/// PURE SEAM: hosts a package source may never be pointed at, even when its manifest lists them —
/// the local machine and the LAN (`localhost`, `*.localhost`, `*.local`, `*.internal`, `*.lan`,
/// `*.home.arpa`, and any IP literal). A third-party package must not become a probe of the user's
/// router, NAS, or Home Assistant instance. Case-insensitive; a trailing dot is ignored.
fn is_internal_host(host: &str) -> bool {
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if h.is_empty() || h == "localhost" {
        return true;
    }
    if h.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .is_ok()
    {
        return true;
    }
    [".localhost", ".local", ".internal", ".lan", ".home.arpa"]
        .iter()
        .any(|suffix| h.ends_with(suffix))
}

/// Marker file that records the user's enable decision SERVER-SIDE (`plugins/<id>/.enabled`),
/// written by `set_package_enabled` from the studio. `package_fetch` refuses to proxy for a package
/// without it, so a webview that never went through the enable/consent gate can't use a package's
/// allowlist as a fetch proxy. Dot-prefixed: its stem fails `valid_name`, so it is unreachable as
/// an asset and undeclarable in a manifest (same trick as the install sidecar).
const ENABLED_MARKER: &str = ".enabled";

/// Record a package's enabled state on disk (the marker file). Studio-only: enabling is a studio
/// action (the Plugins panel), and an overlay must not be able to flip it.
#[tauri::command]
pub async fn set_package_enabled(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    if window.label() != "studio" {
        return Err("set_package_enabled is only allowed from the studio window".into());
    }
    if !valid_name(&id) {
        return Err("invalid package id".to_string());
    }
    let dir = plugins_dir(&app)?.join(&id);
    if !dir.join("plugin.json").is_file() {
        return Err("package manifest not found".to_string());
    }
    let marker = dir.join(ENABLED_MARKER);
    if enabled {
        atomic_write(&marker, "enabled\n")
    } else {
        match fs::remove_file(&marker) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

#[derive(Serialize)]
pub struct PackageFetchResponse {
    pub url: String,
    pub status: u16,
    pub body: String,
}

/// GET `url` on behalf of package `id`'s sandboxed source. Non-2xx responses are returned (with
/// their status) rather than erroring — the sandbox's `transform` decides what a miss means; only
/// transport/validation failures are `Err`. Refused unless the package carries the server-side
/// enabled marker (`set_package_enabled`) and the target host is neither local nor an IP literal.
#[tauri::command]
pub async fn package_fetch(
    app: tauri::AppHandle,
    id: String,
    url: String,
) -> Result<PackageFetchResponse, String> {
    if !valid_name(&id) {
        return Err("invalid package id".to_string());
    }
    let pkg_dir = plugins_dir(&app)?.join(&id);
    let raw = fs::read_to_string(pkg_dir.join("plugin.json"))
        .map_err(|_| "package manifest not found".to_string())?;
    if !pkg_dir.join(ENABLED_MARKER).is_file() {
        return Err("package is not enabled".to_string());
    }
    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "package manifest is not valid JSON".to_string())?;
    let hosts: Vec<String> = json
        .pointer("/source/hosts")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if hosts.is_empty() {
        return Err("package declares no source hosts".to_string());
    }
    if !host_allowed(&url, &hosts) {
        return Err(format!("url is not in the package's host allowlist: {url}"));
    }
    if reqwest::Url::parse(&url)
        .ok()
        .and_then(|u| u.host_str().map(is_internal_host))
        .unwrap_or(true)
    {
        return Err(format!("url targets a local / internal host: {url}"));
    }
    let client = install_http_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GET {url} failed: {e}"))?;
    let status = resp.status().as_u16();
    if let Some(len) = resp.content_length()
        && len > FETCH_CAP as u64
    {
        return Err(format!("{url} is too large ({len} bytes; cap {FETCH_CAP})"));
    }
    use futures_util::StreamExt;
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("GET {url} failed mid-body: {e}"))?;
        if buf.len() + bytes.len() > FETCH_CAP {
            return Err(format!("{url} exceeded the {FETCH_CAP}-byte download cap"));
        }
        buf.extend_from_slice(&bytes);
    }
    let body = String::from_utf8(buf).map_err(|_| format!("{url} body is not valid UTF-8"))?;
    Ok(PackageFetchResponse { url, status, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package_test_dir(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "widgetsack-package-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn package_staging_failure_leaves_existing_install_unchanged() {
        let root = package_test_dir("staging-failure");
        let target = root.join("demo");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("plugin.json"), "old manifest").unwrap();
        std::fs::write(target.join("old.css"), "old css").unwrap();
        let mut writes = 0;

        let result = install_package_directory_with(
            &root,
            "demo",
            "new manifest",
            &[("new.css".into(), "new css".into())],
            "new sidecar",
            true,
            |path, body| {
                writes += 1;
                if writes == 2 {
                    Err("simulated disk failure".into())
                } else {
                    std::fs::write(path, body).map_err(|e| e.to_string())
                }
            },
        );

        assert_eq!(result.unwrap_err(), "simulated disk failure");
        assert_eq!(
            std::fs::read_to_string(target.join("plugin.json")).unwrap(),
            "old manifest"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("old.css")).unwrap(),
            "old css"
        );
        assert!(!target.join("new.css").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn package_update_swaps_the_complete_directory_and_removes_stale_assets() {
        let root = package_test_dir("swap");
        let target = root.join("demo");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("plugin.json"), "old manifest").unwrap();
        std::fs::write(target.join("stale.css"), "stale").unwrap();

        install_package_directory(
            &root,
            "demo",
            "new manifest",
            &[("source.js".into(), "new source".into())],
            "new sidecar",
            true,
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(target.join("plugin.json")).unwrap(),
            "new manifest"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("source.js")).unwrap(),
            "new source"
        );
        assert!(!target.join("stale.css").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fresh_package_install_refuses_an_existing_id() {
        let root = package_test_dir("collision");
        let target = root.join("demo");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("plugin.json"), "keep me").unwrap();

        let err =
            install_package_directory(&root, "demo", "new", &[], "sidecar", false).unwrap_err();

        assert!(err.contains("already installed"));
        assert_eq!(
            std::fs::read_to_string(target.join("plugin.json")).unwrap(),
            "keep me"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn valid_asset_name_requires_css_json_or_js_and_no_traversal() {
        assert!(super::valid_asset_name("theme.css"));
        assert!(super::valid_asset_name("extra.JSON")); // case-insensitive ext
        assert!(super::valid_asset_name("My Theme 2.css")); // spaces ok (valid_name stem)
        assert!(super::valid_asset_name("source.js")); // Phase 2 sandbox script
        assert!(super::valid_asset_name("Source.JS")); // case-insensitive ext
        assert!(!super::valid_asset_name("theme.css.tmp")); // wrong ext (last dot wins)
        assert!(!super::valid_asset_name("evil.tmp.css")); // stem contains a dot
        assert!(!super::valid_asset_name("../theme.css")); // traversal
        assert!(!super::valid_asset_name("..css")); // empty/.. stem
        assert!(!super::valid_asset_name("a/b.css")); // separator
        assert!(!super::valid_asset_name("a\\b.css")); // separator
        assert!(!super::valid_asset_name("theme.exe")); // disallowed ext
        assert!(!super::valid_asset_name("source.mjs")); // js only, not mjs/cjs
        assert!(!super::valid_asset_name("noext")); // no extension
        assert!(!super::valid_asset_name(".css")); // empty stem
        assert!(!super::valid_asset_name("")); // empty
    }

    #[test]
    fn internal_hosts_are_refused_for_package_fetch() {
        use super::is_internal_host;
        for h in [
            "localhost",
            "LOCALHOST.",
            "app.localhost",
            "nas.local",
            "router.lan",
            "svc.internal",
            "printer.home.arpa",
            "127.0.0.1",
            "10.0.0.5",
            "192.168.1.1",
            "[::1]",
            "::1",
            "",
        ] {
            assert!(is_internal_host(h), "{h} should be internal");
        }
        for h in [
            "api.open-meteo.com",
            "github.com",
            "local.example.com",
            "lan.example",
        ] {
            assert!(!is_internal_host(h), "{h} should be public");
        }
    }

    #[test]
    fn host_allowed_matches_exact_https_domains_only() {
        let hosts = vec!["api.open-meteo.com".to_string(), "example.org".to_string()];
        assert!(super::host_allowed(
            "https://api.open-meteo.com/v1/forecast?latitude=1.35",
            &hosts
        ));
        // URL hosts parse case-folded; a SHOUTING url still matches.
        assert!(super::host_allowed("https://API.OPEN-METEO.COM/v1", &hosts));
        // An explicit default port is elided by the parser → still allowed.
        assert!(super::host_allowed("https://example.org:443/", &hosts));
        // Subdomains are NOT implied — they must be listed.
        assert!(!super::host_allowed("https://sub.example.org/", &hosts));
        assert!(!super::host_allowed(
            "https://example.org.evil.com/",
            &hosts
        ));
        // https only, no explicit ports, no credentials, no IP literals.
        assert!(!super::host_allowed("http://api.open-meteo.com/", &hosts));
        assert!(!super::host_allowed(
            "https://api.open-meteo.com:8443/",
            &hosts
        ));
        assert!(!super::host_allowed("https://user@example.org/", &hosts));
        assert!(!super::host_allowed(
            "https://93.184.216.34/",
            &["93.184.216.34".to_string()]
        ));
        // Host case-insensitivity also covers an uppercased (hand-edited) manifest entry.
        assert!(super::host_allowed(
            "https://example.org/",
            &["EXAMPLE.ORG".to_string()]
        ));
        assert!(!super::host_allowed(
            "https://evil.com/?q=example.org",
            &hosts
        ));
        assert!(!super::host_allowed("not a url", &hosts));
        assert!(!super::host_allowed("https://example.org/", &[]));
    }

    #[test]
    fn resolve_package_source_accepts_the_documented_forms() {
        // owner/repo shorthand → raw manifest on main.
        let r = super::resolve_package_source("acme/widget-pack").unwrap();
        assert_eq!(
            r.manifest_url,
            "https://raw.githubusercontent.com/acme/widget-pack/main/plugin.json"
        );
        assert_eq!(r.display_source, "acme/widget-pack");
        assert_eq!(r.reff, "main");
        // Full repo URL (trailing slash + surrounding whitespace tolerated) → same resolution.
        let r = super::resolve_package_source(" https://github.com/acme/widget-pack/ ").unwrap();
        assert_eq!(
            r.manifest_url,
            "https://raw.githubusercontent.com/acme/widget-pack/main/plugin.json"
        );
        assert_eq!(r.display_source, "acme/widget-pack");
        // /tree/<ref> pins the ref; slash-y branch names survive the splitn.
        let r = super::resolve_package_source("https://github.com/acme/widget-pack/tree/feature/x")
            .unwrap();
        assert_eq!(
            r.manifest_url,
            "https://raw.githubusercontent.com/acme/widget-pack/feature/x/plugin.json"
        );
        assert_eq!(r.reff, "feature/x");
        // Any https URL ending in /plugin.json is used verbatim with ref "direct".
        let r =
            super::resolve_package_source("https://example.com/packs/clock/plugin.json").unwrap();
        assert_eq!(
            r.manifest_url,
            "https://example.com/packs/clock/plugin.json"
        );
        assert_eq!(
            r.display_source,
            "https://example.com/packs/clock/plugin.json"
        );
        assert_eq!(r.reff, "direct");
    }

    #[test]
    fn resolve_package_source_rejects_everything_else() {
        assert!(super::resolve_package_source("http://github.com/a/b").is_none()); // plain http
        assert!(super::resolve_package_source("http://example.com/plugin.json").is_none());
        assert!(super::resolve_package_source("https://example.com/pack").is_none()); // no plugin.json
        assert!(super::resolve_package_source("https://github.com/onlyowner").is_none());
        assert!(super::resolve_package_source("https://github.com/a/b/blob/main/x").is_none());
        assert!(super::resolve_package_source("a/b/c").is_none()); // shorthand has ONE slash
        assert!(super::resolve_package_source("owner").is_none());
        assert!(super::resolve_package_source("ftp://a/b").is_none()); // non-https scheme
        assert!(super::resolve_package_source("a/../b").is_none()); // traversal in a segment
        assert!(super::resolve_package_source("ow ner/repo").is_none()); // bad owner char
        assert!(super::resolve_package_source("").is_none());
    }

    #[test]
    fn asset_url_for_swaps_the_last_segment() {
        assert_eq!(
            super::asset_url_for(
                "https://raw.githubusercontent.com/a/b/main/plugin.json",
                "sky.css"
            ),
            "https://raw.githubusercontent.com/a/b/main/sky.css"
        );
        assert_eq!(
            super::asset_url_for("https://example.com/packs/clock/plugin.json", "extra.json"),
            "https://example.com/packs/clock/extra.json"
        );
    }

    #[test]
    fn manifest_url_from_sidecar_rederives_or_fails_closed() {
        // GitHub provenance: owner/repo + recorded ref.
        assert_eq!(
            super::manifest_url_from_sidecar("acme/pack", "v2").as_deref(),
            Some("https://raw.githubusercontent.com/acme/pack/v2/plugin.json")
        );
        // Direct provenance: the URL itself, re-validated through resolve_package_source.
        assert_eq!(
            super::manifest_url_from_sidecar("https://example.com/p/plugin.json", "direct")
                .as_deref(),
            Some("https://example.com/p/plugin.json")
        );
        // Tampered sidecars fail closed.
        assert!(
            super::manifest_url_from_sidecar("http://example.com/p/plugin.json", "direct")
                .is_none()
        );
        assert!(super::manifest_url_from_sidecar("https://example.com/p", "direct").is_none());
        assert!(super::manifest_url_from_sidecar("acme/pack", "..").is_none());
        assert!(super::manifest_url_from_sidecar("acme", "main").is_none());
        assert!(super::manifest_url_from_sidecar("a/../b", "main").is_none());
    }

    #[test]
    fn install_sidecar_is_unreachable_as_an_asset() {
        // The sidecar must never be readable via read_plugin_package_asset or declarable as a
        // manifest asset — its dotted stem fails valid_name.
        assert!(!super::valid_asset_name(super::INSTALL_SIDECAR));
    }
}
