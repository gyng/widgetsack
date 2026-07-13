//! Local agent-control server (OPT-IN). A tiny localhost HTTP endpoint that lets an external agent
//! (via the MCP server) ACTUATE the desktop — control media playback and call Home Assistant services —
//! and read what's playing. This is the write-side companion to the file-based MCP reads.
//!
//! Security posture (deliberately conservative, since this can control media + smart-home):
//!   - OFF by default. Only starts when `LlmConfig.agent_control` is true (a settings toggle).
//!   - Binds 127.0.0.1 ONLY (never 0.0.0.0) on an OS-assigned ephemeral port — not reachable off-box.
//!   - Every mutating/reading request requires `Authorization: Bearer <token>` with a per-launch random
//!     token, AND `Content-Type: application/json`. The token is written to `<config>/mcp/control.json`
//!     (readable only by this user account); a malicious web page can't read it and the JSON
//!     content-type forces a CORS preflight we don't answer — together these stop drive-by CSRF.
//!   - `GET /health` is the only unauthenticated route (liveness check).
//!
//! Reuses the existing command logic directly (`media::media_control`, `ha::ha_call_service`) — no new
//! control paths. Pure seams (`parse_head`, `bearer_ok`, `now_playing_from_records`) are unit-tested.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tauri::async_runtime::{JoinHandle, Mutex};
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

use crate::AppState;
use crate::log;

const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 256 * 1024;
/// A whole request must arrive within this window — defends against slow-loris connections that open a
/// socket and then stall, parking a task forever.
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Cap concurrent in-flight connections so a flood of (even slow) connections can't exhaust tasks/FDs.
const MAX_CONNS: usize = 64;

/// Managed state: the running server task (so a toggle can stop/restart it).
#[derive(Default)]
pub struct ControlState {
    handle: Mutex<Option<JoinHandle<()>>>,
}

/// A per-launch CSPRNG token (256 bits → 64 hex). `getrandom` uses the OS RNG (BCryptGenRandom on
/// Windows). Falls back to a time+pid mix only if the OS RNG is somehow unavailable.
fn gen_token() -> String {
    let mut bytes = [0u8; 32];
    if getrandom::getrandom(&mut bytes).is_err() {
        let seed = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0))
            ^ ((std::process::id() as u128) << 64);
        bytes[..16].copy_from_slice(&seed.to_le_bytes());
        bytes[16..].copy_from_slice(&seed.to_be_bytes());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---- pure seams (unit-tested) ----

#[derive(Debug)]
struct Head {
    method: String,
    /// Path WITHOUT the query string.
    path: String,
    headers: HashMap<String, String>,
}

/// Parse an HTTP request head (everything before the blank line). Header names are lowercased.
fn parse_head(text: &str) -> Option<Head> {
    let mut lines = text.split("\r\n");
    let mut req = lines.next()?.split_whitespace();
    let method = req.next()?.to_string();
    let raw_path = req.next()?;
    let path = raw_path.split('?').next().unwrap_or(raw_path).to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    Some(Head {
        method,
        path,
        headers,
    })
}

/// Constant-time byte equality (no early-out) — avoids leaking a prefix-length timing oracle.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Whether the request carries the exact `Bearer <token>` authorization (constant-time compare).
fn bearer_ok(headers: &HashMap<String, String>, token: &str) -> bool {
    let Some(h) = headers.get("authorization") else {
        return false;
    };
    let Some(got) = h.strip_prefix("Bearer ") else {
        return false;
    };
    ct_eq(got.as_bytes(), token.as_bytes())
}

/// Whether the content type is JSON (forces a CORS preflight a drive-by page can't satisfy).
fn is_json(headers: &HashMap<String, String>) -> bool {
    headers
        .get("content-type")
        .map(|c| c.to_ascii_lowercase().contains("application/json"))
        .unwrap_or(false)
}

/// Extract a compact now-playing list from serialized `SessionRecord`s. The serde shape matches the
/// frontend mirror: `last_media_update = { "Media": [SessionModel, thumb] }` and
/// `last_model_update = { "Model": SessionModel }`, with `media.{title,artist}` + `playback.status`
/// inside the SessionModel. Album-art bytes are ignored. Sessions with no title/artist are skipped.
fn now_playing_from_records(records: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for r in records {
        let media_model = &r["last_media_update"]["Media"][0];
        let model = &r["last_model_update"]["Model"];
        let title = media_model["media"]["title"].as_str().unwrap_or("");
        let artist = media_model["media"]["artist"].as_str().unwrap_or("");
        if title.is_empty() && artist.is_empty() {
            continue;
        }
        let status = model["playback"]["status"]
            .as_str()
            .or_else(|| media_model["playback"]["status"].as_str())
            .unwrap_or("Unknown");
        let source = r["source"].as_str().unwrap_or("");
        out.push(json!({
            "title": title,
            "artist": artist,
            "status": status,
            "source": source,
        }));
    }
    out
}

// ---- config file ----

fn control_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("mcp").join("control.json"))
}

fn write_control_file<R: Runtime>(app: &AppHandle<R>, url: &str, token: &str) {
    let Some(path) = control_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = json!({ "url": url, "token": token }).to_string();
    let _ = crate::command::atomic_write(&path, &body);
}

fn remove_control_file<R: Runtime>(app: &AppHandle<R>) {
    if let Some(path) = control_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

// ---- HTTP I/O ----

async fn write_resp(stream: &mut TcpStream, status: &str, value: &Value) {
    let body = value.to_string();
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.flush().await;
}

fn find_marker(buf: &[u8], marker: &[u8]) -> Option<usize> {
    buf.windows(marker.len()).position(|w| w == marker)
}

/// Read one request (head + body) from the connection. Caps head/body sizes.
async fn read_request(stream: &mut TcpStream) -> Option<(Head, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 2048];
    let head_end = loop {
        if let Some(pos) = find_marker(&buf, b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > MAX_HEAD {
            return None;
        }
        let n = stream.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    };
    let head = parse_head(&String::from_utf8_lossy(&buf[..head_end]))?;
    let content_length: usize = head
        .headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
        .min(MAX_BODY);
    let mut body = buf[head_end..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut tmp).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    body.truncate(content_length);
    Some((head, body))
}

async fn handle_conn<R: Runtime>(app: AppHandle<R>, token: String, mut stream: TcpStream) {
    // Bound the whole request read so a stalled / slow-loris connection can't park this task forever.
    let parsed = match tokio::time::timeout(READ_TIMEOUT, read_request(&mut stream)).await {
        Ok(r) => r,
        Err(_) => return, // timed out reading the request
    };
    let Some((head, body)) = parsed else {
        return;
    };

    // Liveness — the only unauthenticated route.
    if head.method == "GET" && head.path == "/health" {
        write_resp(&mut stream, "200 OK", &json!({ "ok": true })).await;
        return;
    }
    // Everything else needs the bearer token.
    if !bearer_ok(&head.headers, &token) {
        write_resp(
            &mut stream,
            "401 Unauthorized",
            &json!({ "error": "unauthorized" }),
        )
        .await;
        return;
    }

    match (head.method.as_str(), head.path.as_str()) {
        ("GET", "/now_playing") => {
            // Clone records under the lock (a memcpy), then serialize OUTSIDE it — serializing the
            // (large) album-art bytes while holding the lock would briefly stall the live gsmtc updater.
            let records: Vec<crate::state::SessionRecord> = {
                let state: tauri::State<AppState> = app.state();
                let sessions = state.sessions.lock().await;
                sessions.values().cloned().collect()
            };
            let values: Vec<Value> = records
                .iter()
                .filter_map(|r| serde_json::to_value(r).ok())
                .collect();
            write_resp(
                &mut stream,
                "200 OK",
                &json!(now_playing_from_records(&values)),
            )
            .await;
        }
        ("POST", "/media") => {
            if !is_json(&head.headers) {
                write_resp(
                    &mut stream,
                    "415 Unsupported Media Type",
                    &json!({ "error": "send application/json" }),
                )
                .await;
                return;
            }
            let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let Some(action) = v["action"].as_str().map(String::from) else {
                write_resp(
                    &mut stream,
                    "400 Bad Request",
                    &json!({ "error": "missing action" }),
                )
                .await;
                return;
            };
            let source = v["source"].as_str().map(String::from);
            let value = v["value"].as_f64();
            match crate::media::media_control(action, source, value).await {
                Ok(()) => write_resp(&mut stream, "200 OK", &json!({ "ok": true })).await,
                Err(e) => write_resp(&mut stream, "502 Bad Gateway", &json!({ "error": e })).await,
            }
        }
        ("POST", "/ha") => {
            if !is_json(&head.headers) {
                write_resp(
                    &mut stream,
                    "415 Unsupported Media Type",
                    &json!({ "error": "send application/json" }),
                )
                .await;
                return;
            }
            let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let domain = v["domain"].as_str().unwrap_or("").to_string();
            let service = v["service"].as_str().unwrap_or("").to_string();
            if domain.is_empty() || service.is_empty() {
                write_resp(
                    &mut stream,
                    "400 Bad Request",
                    &json!({ "error": "missing domain/service" }),
                )
                .await;
                return;
            }
            let data = v.get("data").cloned().unwrap_or_else(|| json!({}));
            match crate::ha::ha_call_service(app.clone(), domain, service, data).await {
                Ok(res) => {
                    write_resp(&mut stream, "200 OK", &json!({ "ok": true, "result": res })).await
                }
                Err(e) => write_resp(&mut stream, "502 Bad Gateway", &json!({ "error": e })).await,
            }
        }
        _ => {
            write_resp(
                &mut stream,
                "404 Not Found",
                &json!({ "error": "not found" }),
            )
            .await
        }
    }
}

/// Serve on the (already-bound) localhost listener until aborted. Writes `control.json` with the URL +
/// token, then accepts connections — each handled by a task gated by a concurrency semaphore.
async fn run_control_server<R: Runtime>(app: AppHandle<R>, listener: TcpListener, port: u16) {
    let token = gen_token();
    let url = format!("http://127.0.0.1:{port}");
    write_control_file(&app, &url, &token);
    log::info("control", "agent control listening")
        .field("url", &url)
        .emit();

    let sem = Arc::new(Semaphore::new(MAX_CONNS));
    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                // Backpressure: wait for a free slot (stalled connections free theirs via READ_TIMEOUT),
                // so a connection flood can't spawn unbounded tasks.
                let Ok(permit) = sem.clone().acquire_owned().await else {
                    continue; // semaphore closed (never, in practice)
                };
                let app2 = app.clone();
                let token2 = token.clone();
                tauri::async_runtime::spawn(async move {
                    let _permit = permit; // released when the connection is done
                    handle_conn(app2, token2, stream).await;
                });
            }
            Err(e) => {
                log::warn("control", "accept failed")
                    .field("error", e.to_string())
                    .emit();
            }
        }
    }
}

// ---- start/stop (managed) ----

/// Start the control server if enabled in config and not already running. Idempotent.
pub async fn start_if_enabled<R: Runtime>(app: AppHandle<R>, state: &ControlState) {
    let enabled = crate::llm::load_llm_config(&app)
        .ok()
        .flatten()
        .map(|c| c.agent_control)
        .unwrap_or(false);
    if !enabled {
        remove_control_file(&app); // clean up any stale descriptor from a prior session
        return;
    }
    let mut guard = state.handle.lock().await;
    if guard.is_some() {
        return;
    }
    // Bind synchronously so a bind failure is observable and does NOT leave a stale Some(handle) that
    // would block every future restart — the handle is stored only on a successful bind.
    let listener = match TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            log::error("control", "bind failed")
                .field("error", e.to_string())
                .emit();
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(e) => {
            log::error("control", "local_addr failed")
                .field("error", e.to_string())
                .emit();
            return;
        }
    };
    let app2 = app.clone();
    *guard = Some(tauri::async_runtime::spawn(async move {
        run_control_server(app2, listener, port).await;
    }));
}

/// Start (called from the settings toggle after enabling). Idempotent.
#[tauri::command]
pub async fn control_start<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, ControlState>,
) -> Result<(), String> {
    start_if_enabled(app, &state).await;
    Ok(())
}

/// Stop the control server (if running) and remove control.json.
#[tauri::command]
pub async fn control_stop<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, ControlState>,
) -> Result<(), String> {
    if let Some(handle) = state.handle.lock().await.take() {
        handle.abort();
    }
    remove_control_file(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_head_extracts_method_path_and_lowercased_headers() {
        let raw = "POST /media?x=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer abc\r\nContent-Type: application/json\r\n\r\n";
        let h = parse_head(raw).unwrap();
        assert_eq!(h.method, "POST");
        assert_eq!(h.path, "/media"); // query stripped
        assert_eq!(h.headers.get("authorization").unwrap(), "Bearer abc");
        assert!(is_json(&h.headers));
    }

    #[test]
    fn bearer_ok_requires_exact_token() {
        let mut headers = HashMap::new();
        headers.insert("authorization".to_string(), "Bearer secret".to_string());
        assert!(bearer_ok(&headers, "secret"));
        assert!(!bearer_ok(&headers, "other"));
        assert!(!bearer_ok(&HashMap::new(), "secret"));
    }

    #[test]
    fn gen_token_is_64_hex_chars() {
        let t = gen_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn now_playing_extracts_title_artist_status_and_skips_empty() {
        let records = vec![
            json!({
                "source": "Spotify",
                "last_media_update": { "Media": [ { "media": { "title": "Song", "artist": "Band" }, "playback": { "status": "Paused" } }, null ] },
                "last_model_update": { "Model": { "playback": { "status": "Playing" } } }
            }),
            // no media -> skipped
            json!({ "source": "x", "last_media_update": null, "last_model_update": null }),
        ];
        let np = now_playing_from_records(&records);
        assert_eq!(np.len(), 1);
        assert_eq!(np[0]["title"], "Song");
        assert_eq!(np[0]["artist"], "Band");
        // model playback wins over the media event's
        assert_eq!(np[0]["status"], "Playing");
        assert_eq!(np[0]["source"], "Spotify");
    }
}
