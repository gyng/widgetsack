//! Home Assistant proxy source (Phase 8c). The first non-system telemetry source and the
//! worked example of the plugin API's Rust half.
//!
//! HA is a *proxy* source: the long-lived access token and the WebSocket both live here,
//! server-side (`plugins/ha.json` in the app config dir) — the token NEVER crosses the
//! bridge (the more-secure model, locked 2026-06-02). Entity state is forwarded to the
//! webview over the EXISTING `telemetry` event as `ha.<entity_id>` samples, so the
//! unchanged frontend hub ingests it like any other sensor (`SensorValue::Json` always;
//! plus `ha.<entity_id>.state` `Scalar` when the state parses as a number). Control
//! (`ha_call_service`) and the entity catalog (`list_ha_entities`) go over REST so the
//! WS task stays read-only and each command is self-contained.
//!
//! Like `listener.rs`/`sensors.rs` this is an outer-ring adapter: raw HA JSON is wrapped
//! into the project's own `SensorSample`/`SensorValue` at the edge, and the pure seams
//! (`ws_url_from`, `state_to_samples`, `entity_from_state`) are unit-tested without I/O.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::async_runtime::{JoinHandle, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{Connector, connect_async, connect_async_tls_with_config};

use crate::log;
use crate::sensors::{ActiveSensors, SensorSample, SensorValue, TELEMETRY_EVENT};

type BoxErr = Box<dyn std::error::Error + Send + Sync>;

/// The concrete tungstenite stream type, so the connector helper can be shared (returning a
/// generic `impl Stream + Sink` across an `if` is awkward; a named alias keeps it simple).
type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Server-side HA config. The token stays in this struct and on disk only — never
/// serialized back to the webview (see `HaStatus` / `ha_config_status`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HaConfig {
    pub url: String,
    pub token: String,
    /// Accept self-signed / otherwise-invalid TLS certs over `wss`/`https`. Default false —
    /// an explicit opt-in for a LAN HA behind a self-signed cert. `#[serde(default)]` keeps
    /// existing `ha.json` files (which omit it) strict.
    #[serde(default)]
    pub insecure: bool,
    /// Reverse-proxy subpath (e.g. `/homeassistant`), or empty for the host root (default).
    /// `#[serde(default)]` keeps existing `ha.json` files valid. Only set when the proxy forwards
    /// the prefix unmodified — most strip it, so leave blank.
    #[serde(default)]
    pub base_path: String,
}

/// What the webview is allowed to learn about the config: whether it exists, the URL, and the
/// (non-secret) self-signed opt-in so the settings form can reflect it. Deliberately omits the token.
#[derive(Debug, Serialize)]
pub struct HaStatus {
    pub configured: bool,
    pub url: Option<String>,
    pub insecure: bool,
    pub base_path: String,
}

/// Result of a successful WS auth handshake — the server version, for a friendly "connected to
/// Home Assistant 2026.x" message. The token is an INPUT only and is never echoed back here.
#[derive(Debug, Serialize)]
pub struct HaTestResult {
    pub ha_version: Option<String>,
}

/// One HA entity row for the inspector's sensor dropdown. The widget binds to the sensor
/// id `ha.<entity_id>`.
#[derive(Debug, Serialize)]
pub struct HaEntity {
    pub entity_id: String,
    pub state: String,
    pub friendly_name: Option<String>,
    pub unit: Option<String>,
}

/// Registry rows (from the WS `config/*_registry/list` commands) for the area > device > entity
/// browser. These carry STRUCTURE + names only; `device_class`/`unit`/`friendly_name` come from
/// the live STATE (the frontend joins the two). The pure tree builder lives in core/haRegistry.ts.
#[derive(Debug, Serialize)]
pub struct HaArea {
    pub area_id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct HaDevice {
    pub id: String,
    pub name: Option<String>, // name_by_user ?? name
    pub area_id: Option<String>,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HaEntityReg {
    pub entity_id: String,
    pub device_id: Option<String>,
    pub area_id: Option<String>,
    pub name: Option<String>,          // user override (may be null)
    pub original_name: Option<String>, // integration-provided default name
    pub platform: Option<String>,
}

/// The three registries in one snapshot, so the frontend can build the area > device > entity tree.
#[derive(Debug, Serialize)]
pub struct HaRegistry {
    pub areas: Vec<HaArea>,
    pub devices: Vec<HaDevice>,
    pub entities: Vec<HaEntityReg>,
}

/// Managed state: the running WS task (None when disconnected). Guards against a second
/// `ha_connect` spawning a duplicate socket / duplicate snapshot. `latest` is the newest state
/// object per entity (from the snapshot + every `state_changed`, demanded or not), so a window
/// that starts binding an entity later can be primed from it (`prime_window`) instead of waiting
/// for that entity's next change — which for a static sensor may be hours away.
#[derive(Default)]
pub struct HaState {
    handle: Mutex<Option<JoinHandle<()>>>,
    latest: std::sync::Mutex<HashMap<String, Value>>,
    /// The last `ha.status` string emitted (`emit_status`). Status is emitted app-wide on
    /// transitions only, so a window that mounts afterwards (studio from the tray, a late
    /// secondary overlay, a reload) is primed from here — otherwise its tiles never learn the
    /// connection state.
    status: std::sync::Mutex<Option<String>>,
}

impl HaState {
    fn remember(&self, entity_id: &str, state: &Value) {
        let mut latest = self.latest.lock().unwrap_or_else(|e| e.into_inner());
        if state.is_null() {
            latest.remove(entity_id);
        } else {
            latest.insert(entity_id.to_string(), state.clone());
        }
    }
}

/// The HA entity a bound sensor id refers to: `ha.<entity_id>` or `ha.<entity_id>.state`. `None`
/// for anything else (the `ha.status` connection sensor, non-HA ids). Pure.
fn entity_of_sensor_id(sensor_id: &str) -> Option<&str> {
    let rest = sensor_id.strip_prefix("ha.")?;
    let entity = rest.strip_suffix(".state").unwrap_or(rest);
    valid_entity_id(entity).then_some(entity)
}

/// Samples priming a window that just reported demand for `ids`: the cached latest state of each
/// referenced entity (all of them for the `*` wildcard), each entity once. Pure.
fn prime_samples(latest: &HashMap<String, Value>, ids: &[String], ts_ms: u64) -> Vec<SensorSample> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let mut push = |entity: &str, state: &Value| {
        if seen.insert(entity.to_string())
            && let Some(mut samples) = state_to_samples(entity, state, ts_ms)
        {
            out.append(&mut samples);
        }
    };
    if ids.iter().any(|id| id == "*") {
        for (entity, state) in latest {
            push(entity, state);
        }
        return out;
    }
    for id in ids {
        if let Some(entity) = entity_of_sensor_id(id)
            && let Some(state) = latest.get(entity)
        {
            push(entity, state);
        }
    }
    out
}

/// The `ha.status` sample priming a window that just reported demand for `ids`: the last emitted
/// status, iff the window wants the connection sensor (directly or via the `*` wildcard) and a
/// status has been emitted at all. `None` otherwise — a window is never told a status it didn't
/// ask for, and never a made-up one. Pure.
fn prime_status_sample(
    last_status: Option<&str>,
    ids: &[String],
    ts_ms: u64,
) -> Option<SensorSample> {
    let wanted = ids.iter().any(|id| id == "ha.status" || id == "*");
    let status = last_status.filter(|_| wanted)?;
    Some(SensorSample {
        sensor: "ha.status".to_string(),
        ts_ms,
        value: SensorValue::Text(status.to_string()),
    })
}

/// Send `window` the latest cached state of every HA entity among the ids it just started
/// consuming (called from `set_active_sensors` with the ADDED ids only), plus the current
/// connection status when `ha.status` is among them. Closes the demand-gate gap: the stream and
/// snapshot only carry entities some window already wanted, and status is only emitted on
/// transitions, so a widget bound after the fact would otherwise stay blank until its entity next
/// changes — and an HA tile in a late-mounted window would never learn the connection state.
/// Emits to that window alone. A no-op when HA isn't managed / nothing is cached.
pub fn prime_window<R: Runtime>(window: &tauri::WebviewWindow<R>, added: &[String]) {
    if added.is_empty() {
        return;
    }
    let Some(state) = window.app_handle().try_state::<HaState>() else {
        return;
    };
    let batch = {
        let ts_ms = now_ms();
        let latest = state.latest.lock().unwrap_or_else(|e| e.into_inner());
        let status = state.status.lock().unwrap_or_else(|e| e.into_inner());
        let mut batch = prime_samples(&latest, added, ts_ms);
        batch.extend(prime_status_sample(status.as_deref(), added, ts_ms));
        batch
    };
    if !batch.is_empty() {
        let _ = window.emit(TELEMETRY_EVENT, &batch);
    }
}

/// How long `state_changed` samples are held before one coalesced telemetry emit. A busy HA
/// instance fires dozens of state changes a second (power meters, motion, media position); each
/// used to be its own IPC emit + JSON serialise to every webview. One emit per window is plenty
/// for a 1 Hz-ish display.
const EVENT_BATCH_WINDOW: Duration = Duration::from_millis(250);

/// Hard cap on an `entity_picture` body. Covers are tens–hundreds of KB; anything past this is
/// a misconfigured proxy or a hostile server, and the bytes would otherwise be read unbounded into
/// memory and pinned in the art registry.
const ART_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Coalesces streamed `state_changed` samples into one emit per `window`. Pure (no I/O, no timers):
/// the caller pushes samples with the current time, polls `deadline()` to arm its sleep, and takes
/// the batch with `take_due()` once the deadline has passed. The window opens on the FIRST sample
/// after an empty buffer, so a lone event is delayed by at most `window` and a burst is folded into
/// one batch.
struct EventBatcher {
    window: Duration,
    pending: Vec<SensorSample>,
    deadline: Option<Instant>,
}

impl EventBatcher {
    fn new(window: Duration) -> Self {
        Self {
            window,
            pending: Vec::new(),
            deadline: None,
        }
    }

    fn push(&mut self, mut samples: Vec<SensorSample>, now: Instant) {
        if samples.is_empty() {
            return;
        }
        if self.pending.is_empty() {
            self.deadline = Some(now + self.window);
        }
        self.pending.append(&mut samples);
    }

    /// When the pending batch should be emitted (`None` while nothing is pending).
    fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    /// The pending batch if its deadline has passed, else `None` (the batch stays pending).
    fn take_due(&mut self, now: Instant) -> Option<Vec<SensorSample>> {
        match self.deadline {
            Some(deadline) if now >= deadline => Some(self.drain()),
            _ => None,
        }
    }

    /// Everything pending, regardless of the deadline (a connection going away flushes early).
    fn drain(&mut self) -> Vec<SensorSample> {
        self.deadline = None;
        std::mem::take(&mut self.pending)
    }
}

/// Is `sensor_id` one of the ids the frontend binds for HA entity `entity_id` — the JSON
/// `ha.<entity_id>` catalog sample or any `ha.<entity_id>.<field>` derived scalar (`.state`)?
fn is_entity_sensor_id(sensor_id: &str, entity_id: &str) -> bool {
    valid_entity_id(entity_id)
        && sensor_id
            .strip_prefix("ha.")
            .and_then(|rest| rest.strip_prefix(entity_id))
            .is_some_and(|tail| tail.is_empty() || tail.starts_with('.'))
}

/// Demand gate: forward an entity only when some window has a widget bound to it (`ActiveSensors`,
/// the same map the system sensor loop gates NVML/disk/process polling on; the studio's `*`
/// wildcard forwards everything, and so does the pre-first-report startup window). A large HA
/// install streams hundreds of entities nobody displays; without this every one was serialised
/// and pushed to every overlay.
fn entity_wanted(active: &ActiveSensors, entity_id: &str) -> bool {
    active.wanted(|id| is_entity_sensor_id(id, entity_id))
}

/// Append one body chunk to `buf`, refusing to grow past `max` (the caller aborts the read). Pure.
fn accept_art_chunk(buf: &mut Vec<u8>, chunk: &[u8], max: usize) -> Result<(), String> {
    if buf.len() + chunk.len() > max {
        return Err(format!("art body exceeds {max} bytes"));
    }
    buf.extend_from_slice(chunk);
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- liveness budgets ----
// A half-open socket (HA host suspended, Wi-Fi drop, a NAT that forgot the flow) delivers no
// frames AND no error: `ws.next()` would wait forever and the client would report "connected"
// while streaming nothing. Every network wait below is bounded, and the stream is actively probed.

/// TCP + TLS + WebSocket upgrade (and each handshake frame) must complete within this.
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// `{"type":"ping"}` cadence on the streaming socket (HA answers with a `pong` of the same id).
const WS_PING_INTERVAL: Duration = Duration::from_secs(30);
/// No frame at all — or a ping unanswered — for this long is a dead socket: error → reconnect.
const WS_READ_TIMEOUT: Duration = Duration::from_secs(90);
/// Budget for the short REST calls (`/api/states`, a service call) and every connect.
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Pure seam for the application-level ping/pong: tracks the OLDEST unanswered ping so a socket
/// that keeps accepting our pings but never answers is declared dead after `timeout`.
struct Heartbeat {
    timeout: Duration,
    unanswered_since: Option<Instant>,
}

impl Heartbeat {
    fn new(timeout: Duration) -> Self {
        Heartbeat {
            timeout,
            unanswered_since: None,
        }
    }

    /// Called on each ping tick BEFORE the next ping is sent. `Err` once the oldest unanswered ping
    /// is `timeout` old; otherwise records this ping as outstanding (if none already is).
    fn on_tick(&mut self, now: Instant) -> Result<(), String> {
        if let Some(since) = self.unanswered_since
            && now.duration_since(since) >= self.timeout
        {
            return Err(format!(
                "no pong from HA in {}s",
                now.duration_since(since).as_secs()
            ));
        }
        self.unanswered_since.get_or_insert(now);
        Ok(())
    }

    /// Any pong clears the outstanding window (ids are monotonic, so a late pong still proves life).
    fn on_pong(&mut self) {
        self.unanswered_since = None;
    }
}

/// The HA WebSocket ping frame for `id` (`{"id":n,"type":"ping"}`).
fn ping_frame(id: u64) -> String {
    json!({ "id": id, "type": "ping" }).to_string()
}

// ---- config I/O (server-side; token never leaves) ----

fn ha_config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("plugins").join("ha.json"))
}

/// Read `plugins/ha.json`, or `None` if it doesn't exist.
pub fn load_ha_config<R: Runtime>(app: &AppHandle<R>) -> Result<Option<HaConfig>, String> {
    let path = ha_config_path(app)?;
    crate::secure_config::read(&path)?
        .map(|txt| serde_json::from_str(&txt).map_err(|e| e.to_string()))
        .transpose()
}

// ---- pure seams (unit-tested, no I/O) ----

/// Normalize an optional reverse-proxy base path to `""` or `/foo` (leading slash, no trailing).
/// Empty (the default) means HA is served at the host root — the common case. Only set this when a
/// proxy FORWARDS the prefix unmodified (most strip it, so leave it blank — see HaSettings help).
fn norm_base(base: &str) -> String {
    let t = base.trim().trim_matches('/');
    if t.is_empty() {
        String::new()
    } else {
        format!("/{t}")
    }
}

/// Derive the WebSocket URL from the configured HTTP base: `http`→`ws`, `https`→`wss`,
/// strip a trailing slash, append `<base>/api/websocket`.
fn ws_url_from(url: &str, base: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let (scheme, rest) = if let Some(r) = trimmed.strip_prefix("https://") {
        ("wss://", r)
    } else if let Some(r) = trimmed.strip_prefix("http://") {
        ("ws://", r)
    } else if let Some(r) = trimmed.strip_prefix("wss://") {
        ("wss://", r)
    } else if let Some(r) = trimmed.strip_prefix("ws://") {
        ("ws://", r)
    } else {
        ("ws://", trimmed)
    };
    format!("{scheme}{rest}{}/api/websocket", norm_base(base))
}

/// The REST base URL (trailing slash stripped, base path appended) for `/api/...` calls.
fn rest_base(url: &str, base: &str) -> String {
    format!("{}{}", url.trim().trim_end_matches('/'), norm_base(base))
}

/// A reqwest client honouring the `insecure` opt-in. A normal config builds an ordinary
/// (cert-validating) client. Under `insecure` it mirrors the WS connector EXACTLY — dropping
/// BOTH cert and hostname verification — because a self-signed LAN cert usually also has an
/// IP/CN-SAN mismatch, so cert-only would still fail REST hostname checks while wss streamed.
fn ha_http_client(insecure: bool) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().connect_timeout(HTTP_TIMEOUT);
    if insecure {
        builder = builder
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true);
    }
    builder.build().map_err(|e| e.to_string())
}

/// Map one HA state object (from `get_states` or a `state_changed` event) to telemetry
/// samples. `Json(new_state)` is emitted ALWAYS so a `ha.<id>` JSON widget always has the
/// full payload; a separate `ha.<id>.state` `Scalar` is emitted only when the state string
/// parses as a number (so a single id never alternates value kinds across ticks and breaks
/// history buffers). `None` when `new_state` is null (entity removed / unknown).
fn state_to_samples(entity_id: &str, new_state: &Value, ts_ms: u64) -> Option<Vec<SensorSample>> {
    if new_state.is_null() {
        return None;
    }
    let base = format!("ha.{entity_id}");
    let mut out = vec![SensorSample {
        sensor: base.clone(),
        ts_ms,
        value: SensorValue::Json(new_state.clone()),
    }];
    if let Some(s) = new_state["state"].as_str()
        && let Ok(n) = s.parse::<f64>()
    {
        out.push(SensorSample::scalar(format!("{base}.state"), ts_ms, n));
    }
    Some(out)
}

/// A plain `<domain>.<object_id>` HA entity id (lowercase slug). Guards the value before it goes
/// into a request (no `/`, `..`, spaces, etc. — path/param injection defence).
fn valid_entity_id(id: &str) -> bool {
    let mut parts = id.split('.');
    let (Some(domain), Some(object), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !domain.is_empty()
        && !object.is_empty()
        && domain.chars().all(|c| c.is_ascii_lowercase() || c == '_')
        && object
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// A safe HA `entity_picture` path to fetch: host-absolute (`/api/...`), no scheme/host (`//`), no
/// traversal (`..`) or whitespace. The path is appended raw to the REST base, so this guards it.
fn valid_art_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains("..")
        && !path.contains([' ', '\n', '\r', '\t'])
}

/// Parse an ISO-8601 UTC timestamp (HA's `last_changed`/`last_updated`, e.g.
/// "2026-06-17T12:34:56.789+00:00") to epoch milliseconds. HA stores these in UTC, so any zone
/// suffix is ignored (the wall-clock fields are treated as UTC). `None` on a malformed prefix.
/// Pure — unit-tested without I/O. Uses Howard Hinnant's days-from-civil algorithm (no chrono dep).
fn iso8601_to_ms(s: &str) -> Option<u64> {
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let min: i64 = s.get(14..16)?.parse().ok()?;
    let sec: i64 = s.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || min > 59 || sec > 60 {
        return None;
    }
    // Fractional seconds → ms: the first up to 3 digits after a '.', right-padded.
    let frac_ms: i64 = if s.as_bytes().get(19) == Some(&b'.') {
        let mut d = String::new();
        for c in s.get(20..).unwrap_or("").chars() {
            if c.is_ascii_digit() && d.len() < 3 {
                d.push(c);
            } else {
                break;
            }
        }
        while d.len() < 3 {
            d.push('0');
        }
        d.parse().unwrap_or(0)
    } else {
        0
    };
    // days since 1970-01-01 (civil → days), then to seconds + ms.
    let y = if month <= 2 { year - 1 } else { year };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let secs = days * 86400 + hour * 3600 + min * 60 + sec;
    if secs < 0 {
        return None;
    }
    Some((secs * 1000 + frac_ms) as u64)
}

/// Map one entity's HA history array (the inner array from `/api/history/period`'s array-of-arrays)
/// to NUMERIC samples on `ha.<entity_id>.state` — the SAME id the live stream produces, so backfill
/// merges into one series. Non-numeric states (on/off/strings) and unparseable timestamps are
/// skipped. No `Json` variant: backfill exists only to feed numeric sparkline history. Pure seam.
fn history_to_samples(entity_id: &str, history: &Value) -> Vec<SensorSample> {
    let id = format!("ha.{entity_id}.state");
    let Some(rows) = history.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|st| {
            let n = st["state"].as_str()?.parse::<f64>().ok()?;
            let ts_str = st["last_changed"]
                .as_str()
                .or_else(|| st["last_updated"].as_str())?;
            let ts = iso8601_to_ms(ts_str)?;
            Some(SensorSample::scalar(id.clone(), ts, n))
        })
        .collect()
}

/// Classify an auth-phase frame: `Some(Ok)` on `auth_ok` (capturing `ha_version`), `Some(Err)`
/// on `auth_invalid`, `None` for any other frame (keep reading). Pure — unit-tested without I/O.
fn auth_outcome(v: &Value) -> Option<Result<HaTestResult, String>> {
    match v["type"].as_str() {
        Some("auth_ok") => Some(Ok(HaTestResult {
            ha_version: v["ha_version"].as_str().map(String::from),
        })),
        Some("auth_invalid") => {
            let m = v["message"].as_str().unwrap_or("invalid access token");
            Some(Err(format!("auth_invalid: {m}")))
        }
        _ => None,
    }
}

/// Project a `/api/states` row into the inspector's `HaEntity`. `None` if it has no id.
fn entity_from_state(state: &Value) -> Option<HaEntity> {
    Some(HaEntity {
        entity_id: state["entity_id"].as_str()?.to_string(),
        state: state["state"].as_str().unwrap_or_default().to_string(),
        friendly_name: state["attributes"]["friendly_name"]
            .as_str()
            .map(String::from),
        unit: state["attributes"]["unit_of_measurement"]
            .as_str()
            .map(String::from),
    })
}

/// Project a `config/area_registry/list` row. `None` if it has no id. HA may send `name` as null
/// for an unnamed area (rare); fall back to the id so the tree always has a label.
fn area_from(v: &Value) -> Option<HaArea> {
    let area_id = v["area_id"].as_str()?.to_string();
    let name = v["name"].as_str().unwrap_or(&area_id).to_string();
    Some(HaArea { area_id, name })
}

/// Project a `config/device_registry/list` row. `None` if it has no id. Prefers the user-set
/// `name_by_user` over the integration `name`.
fn device_from(v: &Value) -> Option<HaDevice> {
    Some(HaDevice {
        id: v["id"].as_str()?.to_string(),
        name: v["name_by_user"]
            .as_str()
            .or_else(|| v["name"].as_str())
            .map(String::from),
        area_id: v["area_id"].as_str().map(String::from),
        manufacturer: v["manufacturer"].as_str().map(String::from),
        model: v["model"].as_str().map(String::from),
    })
}

/// Project a `config/entity_registry/list` row. `None` if it has no entity id. Keeps both the
/// user override `name` and the `original_name` so the frontend can apply display-name precedence.
fn entity_reg_from(v: &Value) -> Option<HaEntityReg> {
    Some(HaEntityReg {
        entity_id: v["entity_id"].as_str()?.to_string(),
        device_id: v["device_id"].as_str().map(String::from),
        area_id: v["area_id"].as_str().map(String::from),
        name: v["name"].as_str().map(String::from),
        original_name: v["original_name"].as_str().map(String::from),
        platform: v["platform"].as_str().map(String::from),
    })
}

// ---- telemetry emission ----

/// Surface the connection state to widgets as a `ha.status` text sample over the existing
/// telemetry event (a Text meter bound to `ha.status` shows it). Single status transport —
/// no separate bridge event. One of `unconfigured` | `connecting` | `connected` | `disconnected`
/// | `error` (mirrored by core/haTileState.ts + core/haStatus.ts). Remembered in `HaState` so
/// windows that mount later can be primed with it (`prime_window`).
fn emit_status<R: Runtime>(app: &AppHandle<R>, status: &str) {
    if let Some(state) = app.try_state::<HaState>() {
        *state.status.lock().unwrap_or_else(|e| e.into_inner()) = Some(status.to_string());
    }
    let batch = vec![SensorSample {
        sensor: "ha.status".to_string(),
        ts_ms: now_ms(),
        value: SensorValue::Text(status.to_string()),
    }];
    let _ = app.emit(TELEMETRY_EVENT, &batch);
}

/// Prime every DEMANDED entity from a `get_states` snapshot so widgets render immediately (same
/// gate as the event stream — a window only ever receives entities it binds, or all with `*`).
fn emit_snapshot<R: Runtime>(app: &AppHandle<R>, states: &Value) {
    let Some(arr) = states.as_array() else {
        return;
    };
    let active = app.state::<ActiveSensors>();
    let ha = app.state::<HaState>();
    let ts = now_ms();
    let mut batch = Vec::new();
    for st in arr {
        let Some(eid) = st["entity_id"].as_str() else {
            continue;
        };
        ha.remember(eid, st); // cached for later-binding windows regardless of current demand
        if entity_wanted(&active, eid)
            && let Some(mut samples) = state_to_samples(eid, st, ts)
        {
            batch.append(&mut samples);
        }
    }
    if !batch.is_empty() {
        let _ = app.emit(TELEMETRY_EVENT, &batch);
    }
}

// ---- connection task ----

/// Read frames until one of type `expected` arrives (ignoring unrelated frames). Treats
/// `auth_invalid`, a closed/ended stream, and `WS_CONNECT_TIMEOUT` of silence as errors.
async fn expect_type<S>(ws: &mut S, expected: &str) -> Result<(), BoxErr>
where
    S: Stream<Item = Result<Message, WsError>> + Unpin,
{
    tokio::time::timeout(WS_CONNECT_TIMEOUT, expect_type_inner(ws, expected))
        .await
        .map_err(|_| format!("timed out waiting for `{expected}` during handshake"))?
}

async fn expect_type_inner<S>(ws: &mut S, expected: &str) -> Result<(), BoxErr>
where
    S: Stream<Item = Result<Message, WsError>> + Unpin,
{
    while let Some(msg) = ws.next().await {
        match msg? {
            Message::Text(txt) => {
                let v: Value = serde_json::from_str(&txt)?;
                let ty = v["type"].as_str().unwrap_or_default();
                if ty == expected {
                    return Ok(());
                }
                if ty == "auth_invalid" {
                    let m = v["message"].as_str().unwrap_or_default();
                    return Err(format!("auth_invalid: {m}").into());
                }
            }
            Message::Close(_) => return Err("connection closed during handshake".into()),
            _ => {}
        }
    }
    Err("stream ended during handshake".into())
}

/// Open the HA WebSocket, honouring the `insecure` self-signed opt-in. Valid certs (and plain
/// `ws://`) work transparently via the native-tls backend; `insecure` swaps in a connector that
/// accepts self-signed certs (explicit opt-in only). Shared by the live client and
/// `ha_test_connection` so the two TLS paths cannot drift.
async fn connect_ws(ws_url: &str, insecure: bool) -> Result<WsStream, BoxErr> {
    tokio::time::timeout(WS_CONNECT_TIMEOUT, connect_ws_inner(ws_url, insecure))
        .await
        .map_err(|_| format!("connect timed out after {}s", WS_CONNECT_TIMEOUT.as_secs()))?
}

async fn connect_ws_inner(ws_url: &str, insecure: bool) -> Result<WsStream, BoxErr> {
    if insecure {
        let tls = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
            .build()?;
        let (ws, _resp) =
            connect_async_tls_with_config(ws_url, None, false, Some(Connector::NativeTls(tls)))
                .await?;
        Ok(ws)
    } else {
        let (ws, _resp) = connect_async(ws_url).await?;
        Ok(ws)
    }
}

/// Open a short-lived authenticated WS, issue one or more `type`-only commands (ids 1..=n), collect
/// their `result` payloads in order, then drop the socket. Used for the registry snapshot
/// (areas/devices/entities) which is request/response, unlike the long-lived streaming task.
async fn ws_request_many(
    ws_url: &str,
    token: &str,
    insecure: bool,
    commands: &[&str],
) -> Result<Vec<Value>, BoxErr> {
    let mut ws = connect_ws(ws_url, insecure).await?;

    // Auth phase (same handshake as the streaming client).
    expect_type(&mut ws, "auth_required").await?;
    ws.send(Message::Text(
        json!({ "type": "auth", "access_token": token }).to_string(),
    ))
    .await?;
    expect_type(&mut ws, "auth_ok").await?;

    // Issue every command up front; ids are 1-based and map to the request index.
    for (i, ty) in commands.iter().enumerate() {
        let id = (i + 1) as u64;
        ws.send(Message::Text(json!({ "id": id, "type": ty }).to_string()))
            .await?;
    }

    // Collect results by id until all are in.
    let mut results: Vec<Option<Value>> = vec![None; commands.len()];
    let mut remaining = commands.len();
    while remaining > 0 {
        let next = tokio::time::timeout(WS_READ_TIMEOUT, ws.next())
            .await
            .map_err(|_| "timed out waiting for registry results")?;
        match next {
            Some(msg) => match msg? {
                Message::Text(txt) => {
                    let v: Value = serde_json::from_str(&txt)?;
                    if v["type"] == "result"
                        && let Some(id) = v["id"].as_u64()
                    {
                        let idx = (id as usize).wrapping_sub(1);
                        if idx < results.len() && results[idx].is_none() {
                            if v["success"].as_bool().unwrap_or(false) {
                                results[idx] = Some(v["result"].clone());
                            } else {
                                let code = v["error"]["code"].as_str().unwrap_or("unknown");
                                return Err(format!("{} failed: {code}", commands[idx]).into());
                            }
                            remaining -= 1;
                        }
                    }
                }
                Message::Ping(p) => ws.send(Message::Pong(p)).await?,
                Message::Close(_) => return Err("connection closed during registry fetch".into()),
                _ => {}
            },
            None => return Err("stream ended during registry fetch".into()),
        }
    }
    Ok(results
        .into_iter()
        .map(|r| r.unwrap_or(Value::Null))
        .collect())
}

/// One connection lifecycle: connect → auth → seed snapshot → subscribe → stream events.
/// Returns `Ok` on a clean close, `Err` on any failure (the caller backs off + retries).
async fn connect_and_stream<R: Runtime>(
    app: &AppHandle<R>,
    ws_url: &str,
    token: &str,
    insecure: bool,
) -> Result<(), BoxErr> {
    let mut ws = connect_ws(ws_url, insecure).await?;

    // Auth phase: frames carry no id. auth_required → auth → auth_ok (auth_invalid is fatal).
    expect_type(&mut ws, "auth_required").await?;
    let auth = json!({ "type": "auth", "access_token": token }).to_string();
    ws.send(Message::Text(auth)).await?;
    expect_type(&mut ws, "auth_ok").await?;
    emit_status(app, "connected");

    // Command phase: per-connection ids must strictly increase (HA rejects reuse).
    let next_id = AtomicU64::new(1);
    let snapshot_id = next_id.fetch_add(1, Ordering::SeqCst);
    let get_states = json!({ "id": snapshot_id, "type": "get_states" }).to_string();
    ws.send(Message::Text(get_states)).await?;
    let sub_id = next_id.fetch_add(1, Ordering::SeqCst);
    let subscribe = json!({
        "id": sub_id, "type": "subscribe_events", "event_type": "state_changed"
    })
    .to_string();
    ws.send(Message::Text(subscribe)).await?;

    // Liveness: an idle deadline (no frame of any kind for WS_READ_TIMEOUT) plus an app-level
    // ping every WS_PING_INTERVAL whose pong must arrive within the same budget. Either failing
    // is an error, so the outer loop reconnects instead of sitting on a dead socket forever.
    let mut heartbeat = Heartbeat::new(WS_READ_TIMEOUT);
    let mut ping = tokio::time::interval(WS_PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await; // the first tick is immediate; the next is one interval out
    let mut last_frame = tokio::time::Instant::now();
    // `state_changed` samples are coalesced into one emit per EVENT_BATCH_WINDOW (see EventBatcher).
    let mut batcher = EventBatcher::new(EVENT_BATCH_WINDOW);
    let active = app.state::<ActiveSensors>();
    let ha = app.state::<HaState>();

    loop {
        let idle = tokio::time::sleep_until(last_frame + WS_READ_TIMEOUT);
        let flush_at = batcher.deadline().map(tokio::time::Instant::from_std);
        let msg = tokio::select! {
            _ = idle => {
                return Err(format!(
                    "no frame from HA in {}s",
                    WS_READ_TIMEOUT.as_secs()
                )
                .into());
            }
            _ = ping.tick() => {
                heartbeat.on_tick(Instant::now())?;
                let id = next_id.fetch_add(1, Ordering::SeqCst);
                ws.send(Message::Text(ping_frame(id))).await?;
                continue;
            }
            _ = tokio::time::sleep_until(flush_at.unwrap_or_else(tokio::time::Instant::now)), if flush_at.is_some() => {
                if let Some(batch) = batcher.take_due(Instant::now()) {
                    let _ = app.emit(TELEMETRY_EVENT, &batch);
                }
                continue;
            }
            msg = ws.next() => msg,
        };
        let Some(msg) = msg else { break };
        last_frame = tokio::time::Instant::now();
        match msg? {
            Message::Text(txt) => {
                let v: Value = serde_json::from_str(&txt)?;
                match v["type"].as_str() {
                    Some("pong") => heartbeat.on_pong(),
                    Some("result") => {
                        let id = v["id"].as_u64();
                        if v["success"].as_bool().unwrap_or(false) {
                            if id == Some(snapshot_id) {
                                emit_snapshot(app, &v["result"]);
                            }
                        } else {
                            let code = v["error"]["code"].as_str().unwrap_or("unknown");
                            // A failed subscribe would leave us connected but deaf — bail so
                            // the outer loop reconnects rather than lying about "connected".
                            if id == Some(sub_id) {
                                return Err(format!("subscribe_events failed: {code}").into());
                            }
                            log::warn("ha", "result error")
                                .field("id", format!("{id:?}"))
                                .field("code", code)
                                .emit();
                        }
                    }
                    Some("event") if v["event"]["event_type"] == "state_changed" => {
                        let data = &v["event"]["data"];
                        if let Some(eid) = data["entity_id"].as_str() {
                            ha.remember(eid, &data["new_state"]);
                            if entity_wanted(&active, eid)
                                && let Some(batch) =
                                    state_to_samples(eid, &data["new_state"], now_ms())
                            {
                                batcher.push(batch, Instant::now());
                            }
                        }
                    }
                    _ => {}
                }
            }
            Message::Ping(p) => ws.send(Message::Pong(p)).await?,
            Message::Close(_) => break,
            _ => {}
        }
    }
    // A clean close flushes whatever was still pending rather than dropping the last window.
    let rest = batcher.drain();
    if !rest.is_empty() {
        let _ = app.emit(TELEMETRY_EVENT, &rest);
    }
    Ok(())
}

/// Reconnecting client loop: owns the single backoff. Exponential backoff (1s→30s) with
/// jitter; the backoff is reset to 1s only after a session that stayed up long enough to be
/// considered healthy (so an auth-then-immediate-close flap can't pin a 1s hammer loop).
/// Runs until the task is aborted by `ha_disconnect`.
pub async fn run_ha_client<R: Runtime>(app: AppHandle<R>, cfg: HaConfig) {
    let ws_url = ws_url_from(&cfg.url, &cfg.base_path);
    let mut backoff = Duration::from_secs(1);
    const STABLE: Duration = Duration::from_secs(30);
    const CAP: Duration = Duration::from_secs(30);
    loop {
        emit_status(&app, "connecting");
        let started = Instant::now();
        match connect_and_stream(&app, &ws_url, &cfg.token, cfg.insecure).await {
            Ok(()) => emit_status(&app, "disconnected"),
            Err(err) => {
                log::warn("ha", "client error").field("error", err).emit();
                emit_status(&app, "error");
            }
        }
        if started.elapsed() >= STABLE {
            backoff = Duration::from_secs(1);
        }
        let jitter = Duration::from_millis(now_ms() % 750);
        tokio::time::sleep(backoff + jitter).await;
        backoff = (backoff * 2).min(CAP);
    }
}

// ---- Tauri commands ----

/// Persist `plugins/ha.json` (creates `plugins/`). The token is written server-side only.
/// Studio-only: a settings WRITE must come from the designer window, not a click-through overlay.
#[tauri::command]
pub async fn save_ha_config(
    window: tauri::WebviewWindow,
    app: AppHandle,
    url: String,
    token: String,
    insecure: Option<bool>,
    base_path: Option<String>,
) -> Result<(), String> {
    if window.label() != "studio" {
        return Err("save_ha_config is only allowed from the studio window".into());
    }
    let path = ha_config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // A blank token means "keep the existing one" — the UI never reads the token back (it is
    // write-only), so editing just the URL/insecure must not silently wipe a saved token.
    let token = if token.is_empty() {
        load_ha_config(&app)?.map(|c| c.token).unwrap_or_default()
    } else {
        token
    };
    let cfg = HaConfig {
        url,
        token,
        insecure: insecure.unwrap_or(false),
        base_path: base_path.unwrap_or_default(),
    };
    let txt = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    crate::secure_config::write(&path, &txt)
}

/// Validate an UNSAVED url/token/insecure combination by running the WS auth handshake, so the
/// config UI can tell "bad token" / "cert not trusted" / "unreachable" apart before persisting.
/// Takes params (not `ha.json`) and uses a throwaway socket that closes when this returns (the
/// stream is dropped). Reuses the same `connect_ws` + `expect_type` seams as the live client.
#[tauri::command]
pub async fn ha_test_connection(
    window: tauri::WebviewWindow,
    app: AppHandle,
    url: String,
    token: String,
    insecure: Option<bool>,
    base_path: Option<String>,
) -> Result<HaTestResult, String> {
    if window.label() != "studio" {
        return Err("ha_test_connection is only allowed from the studio window".into());
    }
    // Blank token = "test with the already-saved token" (the UI can't hold it — write-only), so
    // the user can validate a changed URL/insecure against their existing credential.
    let token = if token.is_empty() {
        load_ha_config(&app)?.map(|c| c.token).unwrap_or_default()
    } else {
        token
    };
    if token.is_empty() {
        return Err("no access token — enter one to test".into());
    }
    let ws_url = ws_url_from(&url, &base_path.unwrap_or_default());
    let mut ws = connect_ws(&ws_url, insecure.unwrap_or(false))
        .await
        .map_err(|e| format!("could not connect: {e}"))?;
    expect_type(&mut ws, "auth_required")
        .await
        .map_err(|e| e.to_string())?;
    let auth = json!({ "type": "auth", "access_token": token }).to_string();
    ws.send(Message::Text(auth))
        .await
        .map_err(|e| e.to_string())?;
    while let Some(msg) = ws.next().await {
        if let Message::Text(txt) = msg.map_err(|e| e.to_string())? {
            let v: Value = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
            if let Some(outcome) = auth_outcome(&v) {
                return outcome; // `ws` is dropped here, closing the throwaway socket.
            }
        }
    }
    Err("connection closed during authentication".into())
}

/// Whether HA is configured + its URL — NEVER the token.
#[tauri::command]
pub async fn ha_config_status<R: Runtime>(app: AppHandle<R>) -> Result<HaStatus, String> {
    // The file read + DPAPI decrypt run on the blocking pool: a sync command would do them on
    // the UI thread, and this is polled by every window's settings/status probe.
    let cfg = tokio::task::spawn_blocking(move || load_ha_config(&app))
        .await
        .map_err(|e| e.to_string())??;
    match cfg {
        Some(cfg) => Ok(HaStatus {
            configured: true,
            url: Some(cfg.url),
            insecure: cfg.insecure,
            base_path: cfg.base_path,
        }),
        None => Ok(HaStatus {
            configured: false,
            url: None,
            insecure: false,
            base_path: String::new(),
        }),
    }
}

/// Start the streaming WS task iff configured and not already running. Idempotent: a second
/// call while running is a no-op (no duplicate socket).
#[tauri::command]
pub async fn ha_connect<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, HaState>,
) -> Result<(), String> {
    let cfg = match load_ha_config(&app)? {
        Some(cfg) => cfg,
        None => {
            // Not configured: nothing to connect. Say so explicitly — the tiles show "not
            // configured" only on this status, never on the mere absence of one (a window that
            // simply hasn't heard yet must not send the user to the Plugins panel).
            emit_status(&app, "unconfigured");
            return Ok(());
        }
    };
    let mut guard = state.handle.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let app_for_task = app.clone();
    *guard = Some(tauri::async_runtime::spawn(async move {
        run_ha_client(app_for_task, cfg).await;
    }));
    Ok(())
}

/// Stop the streaming WS task (if any). Aborting skips the loop's own `disconnected` emit, so
/// it is emitted here — otherwise the remembered status would stay `connected` for a dead task.
#[tauri::command]
pub async fn ha_disconnect<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, HaState>,
) -> Result<(), String> {
    if let Some(handle) = state.handle.lock().await.take() {
        handle.abort();
        emit_status(&app, "disconnected");
    }
    Ok(())
}

/// The HA entities (via REST `/api/states`), for the inspector's sensor dropdown. Its own
/// fetch, so it works regardless of the WS task's timing.
#[tauri::command]
pub async fn list_ha_entities<R: Runtime>(app: AppHandle<R>) -> Result<Vec<HaEntity>, String> {
    let cfg = load_ha_config(&app)?.ok_or("HA not configured")?;
    let client = ha_http_client(cfg.insecure)?;
    let resp = client
        .get(format!(
            "{}/api/states",
            rest_base(&cfg.url, &cfg.base_path)
        ))
        .bearer_auth(&cfg.token)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GET /api/states failed: {}", resp.status()));
    }
    let states: Vec<Value> = resp.json().await.map_err(|e| e.to_string())?;
    Ok(states.iter().filter_map(entity_from_state).collect())
}

/// The HA registries (areas, devices, entities) over a short-lived WS, for the area > device >
/// entity browser. WS-only commands (no REST equivalent). Token stays server-side; the returned
/// rows carry no secrets. The frontend joins these with live states into the tree.
#[tauri::command]
pub async fn ha_registry_snapshot<R: Runtime>(app: AppHandle<R>) -> Result<HaRegistry, String> {
    let cfg = load_ha_config(&app)?.ok_or("HA not configured")?;
    let ws_url = ws_url_from(&cfg.url, &cfg.base_path);
    let results = ws_request_many(
        &ws_url,
        &cfg.token,
        cfg.insecure,
        &[
            "config/area_registry/list",
            "config/device_registry/list",
            "config/entity_registry/list",
        ],
    )
    .await
    .map_err(|e| e.to_string())?;
    let as_rows = |v: &Value| v.as_array().cloned().unwrap_or_default();
    Ok(HaRegistry {
        areas: as_rows(&results[0]).iter().filter_map(area_from).collect(),
        devices: as_rows(&results[1])
            .iter()
            .filter_map(device_from)
            .collect(),
        entities: as_rows(&results[2])
            .iter()
            .filter_map(entity_reg_from)
            .collect(),
    })
}

/// Call an HA service (REST `POST /api/services/<domain>/<service>`). `data` is the body
/// (e.g. `{ "entity_id": "light.kitchen" }`). Domain/service are validated to contain no
/// path separators (`/`, `.`) to prevent path injection. Returns HA's changed-states array.
#[tauri::command]
pub async fn ha_call_service<R: Runtime>(
    app: AppHandle<R>,
    domain: String,
    service: String,
    data: Value,
) -> Result<Value, String> {
    let bad = |s: &str| s.is_empty() || s.contains('/') || s.contains('.');
    if bad(&domain) || bad(&service) {
        return Err("invalid domain/service".to_string());
    }
    let cfg = load_ha_config(&app)?.ok_or("HA not configured")?;
    let client = ha_http_client(cfg.insecure)?;
    let resp = client
        .post(format!(
            "{}/api/services/{}/{}",
            rest_base(&cfg.url, &cfg.base_path),
            domain,
            service
        ))
        .bearer_auth(&cfg.token)
        .json(&data)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HA service call failed: {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

/// Fetch historical state for ONE entity over [start, end] (ISO-8601 UTC) via REST
/// `/api/history/period`, returning NUMERIC samples on `ha.<entity_id>.state` for sparkline
/// backfill. `minimal_response` + `significant_changes_only` + numeric-only keep the payload small;
/// the caller ingests the result into its OWN hub (no telemetry emit), so each window backfills once
/// without double-counting. Errors never include the token.
#[tauri::command]
pub async fn ha_history<R: Runtime>(
    app: AppHandle<R>,
    entity_id: String,
    start: String,
    end: String,
) -> Result<Vec<SensorSample>, String> {
    if !valid_entity_id(&entity_id) {
        return Err("invalid entity_id".to_string());
    }
    // `start` is interpolated into the URL PATH (`end` into a query) — require a real ISO-8601
    // timestamp so neither can carry path/query separators (`/`, `?`, `#`) or other junk.
    if iso8601_to_ms(&start).is_none() || iso8601_to_ms(&end).is_none() {
        return Err("invalid time range".to_string());
    }
    let cfg = load_ha_config(&app)?.ok_or("HA not configured")?;
    let client = ha_http_client(cfg.insecure)?;
    // parse_with_params percent-encodes the query (the ISO `end_time` carries ':' and '+').
    let url = reqwest::Url::parse_with_params(
        &format!(
            "{}/api/history/period/{}",
            rest_base(&cfg.url, &cfg.base_path),
            start
        ),
        &[
            ("filter_entity_id", entity_id.as_str()),
            ("end_time", end.as_str()),
            ("minimal_response", ""),
            ("significant_changes_only", ""),
        ],
    )
    .map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .bearer_auth(&cfg.token)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GET /api/history failed: {}", resp.status()));
    }
    // HA returns an array-of-arrays (one inner array per filtered entity); we filtered to one.
    let data: Vec<Value> = resp.json().await.map_err(|e| e.to_string())?;
    Ok(data
        .first()
        .map(|h| history_to_samples(&entity_id, h))
        .unwrap_or_default())
}

/// Fetch an HA `entity_picture` (e.g. a media_player cover) over REST using the server-side token +
/// insecure opt-in, store the bytes in the shared album-art registry, and return the
/// `http://art.localhost/<hash>` URL the webview can `<img>`-load. Reuses the now-playing art scheme
/// (already allowed by the CSP), so no bytes cross the JSON bridge and no CSP change is needed. The
/// token never crosses the bridge; errors never include it.
#[tauri::command]
pub async fn ha_media_art<R: Runtime>(app: AppHandle<R>, path: String) -> Result<String, String> {
    if !valid_art_path(&path) {
        return Err("invalid art path".to_string());
    }
    let cfg = load_ha_config(&app)?.ok_or("HA not configured")?;
    let client = ha_http_client(cfg.insecure)?;
    let resp = client
        .get(format!("{}{}", rest_base(&cfg.url, &cfg.base_path), path))
        .bearer_auth(&cfg.token)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GET art failed: {}", resp.status()));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    // Bounded, streaming read: refuse an oversized declared length up front, and abort mid-body
    // if an undeclared one grows past the cap — never buffer an unbounded response.
    if resp
        .content_length()
        .is_some_and(|n| n > ART_MAX_BYTES as u64)
    {
        return Err(format!("art body exceeds {ART_MAX_BYTES} bytes"));
    }
    let mut resp = resp;
    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        accept_art_chunk(&mut bytes, &chunk, ART_MAX_BYTES)?;
    }
    let img = std::sync::Arc::new(crate::listener::ImageWrapper::new(content_type, bytes));
    let hash = img.hash;
    app.state::<crate::art::ArtState>()
        .0
        .lock()
        .unwrap()
        .insert(hash, img);
    Ok(crate::art::art_url(hash))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heartbeat_errors_once_a_ping_goes_unanswered_past_the_timeout() {
        let t0 = Instant::now();
        let at = |secs: u64| t0 + Duration::from_secs(secs);
        let mut hb = Heartbeat::new(Duration::from_secs(90));
        // Pings at 0 / 30 / 60 s with no pong: still within budget…
        assert!(hb.on_tick(at(0)).is_ok());
        assert!(hb.on_tick(at(30)).is_ok());
        assert!(hb.on_tick(at(60)).is_ok());
        // …the tick at 90 s finds the FIRST ping (t=0) unanswered for the full timeout → dead.
        let err = hb.on_tick(at(90)).unwrap_err();
        assert!(err.contains("no pong"), "{err}");
    }

    #[test]
    fn heartbeat_pong_resets_the_window() {
        let t0 = Instant::now();
        let at = |secs: u64| t0 + Duration::from_secs(secs);
        let mut hb = Heartbeat::new(Duration::from_secs(90));
        assert!(hb.on_tick(at(0)).is_ok());
        hb.on_pong();
        // 100 s later than the first ping, but that one was answered — the window restarted here.
        assert!(hb.on_tick(at(100)).is_ok());
        assert!(hb.on_tick(at(150)).is_ok());
        assert!(hb.on_tick(at(190)).is_err());
    }

    #[test]
    fn ping_frame_is_the_ha_ws_ping_shape() {
        let v: Value = serde_json::from_str(&ping_frame(7)).unwrap();
        assert_eq!(v, serde_json::json!({ "id": 7, "type": "ping" }));
    }

    #[test]
    fn event_batcher_folds_a_burst_into_one_batch_due_after_the_window() {
        let t0 = Instant::now();
        let window = Duration::from_millis(250);
        let mut b = EventBatcher::new(window);
        assert_eq!(b.deadline(), None);
        assert!(b.take_due(t0).is_none());

        let first = state_to_samples("sensor.a", &json!({"state": "1"}), 1).unwrap();
        b.push(first, t0);
        // The window opens on the first sample…
        assert_eq!(b.deadline(), Some(t0 + window));
        // …and later pushes within it don't move the deadline.
        let second = state_to_samples("sensor.b", &json!({"state": "2"}), 2).unwrap();
        b.push(second, t0 + Duration::from_millis(100));
        assert_eq!(b.deadline(), Some(t0 + window));
        // Not due yet → nothing is emitted and the batch stays pending.
        assert!(b.take_due(t0 + Duration::from_millis(249)).is_none());
        // Due → one batch carrying both entities (4 samples: json + scalar each), in arrival order.
        let batch = b.take_due(t0 + window).expect("due");
        assert_eq!(
            batch.iter().map(|s| s.sensor.as_str()).collect::<Vec<_>>(),
            [
                "ha.sensor.a",
                "ha.sensor.a.state",
                "ha.sensor.b",
                "ha.sensor.b.state"
            ]
        );
        // Emptied: the next sample opens a fresh window.
        assert_eq!(b.deadline(), None);
        let t1 = t0 + Duration::from_secs(1);
        b.push(
            state_to_samples("sensor.c", &json!({"state": "x"}), 3).unwrap(),
            t1,
        );
        assert_eq!(b.deadline(), Some(t1 + window));
        // Empty pushes never arm a window.
        let mut empty = EventBatcher::new(window);
        empty.push(Vec::new(), t0);
        assert_eq!(empty.deadline(), None);
        // drain flushes early (connection close) and disarms.
        assert_eq!(b.drain().len(), 1);
        assert_eq!(b.deadline(), None);
    }

    #[test]
    fn entity_sensor_ids_match_the_json_and_derived_scalar_only() {
        assert!(is_entity_sensor_id("ha.light.kitchen", "light.kitchen"));
        assert!(is_entity_sensor_id(
            "ha.light.kitchen.state",
            "light.kitchen"
        ));
        // A longer entity id sharing the prefix is a different entity.
        assert!(!is_entity_sensor_id("ha.light.kitchen2", "light.kitchen"));
        assert!(!is_entity_sensor_id(
            "ha.light.kitchen_lamp.state",
            "light.kitchen"
        ));
        // Non-HA ids and the connection sensor never match an entity.
        assert!(!is_entity_sensor_id("cpu.total", "light.kitchen"));
        assert!(!is_entity_sensor_id("ha.status", "status"));
    }

    #[test]
    fn entity_wanted_follows_window_demand_and_the_wildcard() {
        use std::collections::{HashMap, HashSet};
        let active = ActiveSensors::default();
        // Startup fallback: nothing reported yet → forward everything.
        assert!(entity_wanted(&active, "light.kitchen"));
        let set = |ids: &[&str]| ids.iter().map(|s| s.to_string()).collect::<HashSet<_>>();
        *active.0.lock().unwrap() =
            HashMap::from([("overlay-1".to_string(), set(&["ha.light.kitchen.state"]))]);
        active.1.store(true, Ordering::Release);
        assert!(entity_wanted(&active, "light.kitchen"));
        assert!(!entity_wanted(&active, "switch.fan"));
        // The studio's wildcard wants every entity.
        active
            .0
            .lock()
            .unwrap()
            .insert("studio".to_string(), set(&["*"]));
        assert!(entity_wanted(&active, "switch.fan"));
    }

    #[test]
    fn entity_of_sensor_id_maps_json_and_state_ids_only() {
        assert_eq!(
            entity_of_sensor_id("ha.light.kitchen"),
            Some("light.kitchen")
        );
        assert_eq!(
            entity_of_sensor_id("ha.sensor.temp.state"),
            Some("sensor.temp")
        );
        assert_eq!(entity_of_sensor_id("ha.status"), None); // the connection sensor
        assert_eq!(entity_of_sensor_id("cpu.total"), None);
        assert_eq!(entity_of_sensor_id("ha.bad/id"), None);
    }

    #[test]
    fn prime_samples_replays_cached_states_for_the_added_ids_once_each() {
        let latest: HashMap<String, Value> = HashMap::from([
            (
                "sensor.temp".to_string(),
                json!({"entity_id": "sensor.temp", "state": "21.5"}),
            ),
            (
                "light.kitchen".to_string(),
                json!({"entity_id": "light.kitchen", "state": "on"}),
            ),
        ]);
        // Both ids of one entity + an unknown entity + a non-HA id → that entity's samples once.
        let ids = [
            "ha.sensor.temp".to_string(),
            "ha.sensor.temp.state".to_string(),
            "ha.switch.gone".to_string(),
            "cpu.total".to_string(),
        ];
        let batch = prime_samples(&latest, &ids, 7);
        assert_eq!(
            batch.iter().map(|s| s.sensor.as_str()).collect::<Vec<_>>(),
            ["ha.sensor.temp", "ha.sensor.temp.state"]
        );
        assert!(batch.iter().all(|s| s.ts_ms == 7));
        // The wildcard (a late-opened studio) replays every cached entity.
        let all = prime_samples(&latest, &["*".to_string()], 7);
        assert_eq!(all.len(), 3); // temp json + temp scalar + light json
        assert!(prime_samples(&latest, &[], 7).is_empty());
    }

    #[test]
    fn prime_status_sample_replays_the_last_status_to_windows_that_want_it() {
        let wants_status = ["ha.status".to_string(), "ha.light.a".to_string()];
        let s = prime_status_sample(Some("connected"), &wants_status, 9).expect("primed");
        assert_eq!(s.sensor, "ha.status");
        assert_eq!(s.ts_ms, 9);
        assert!(matches!(s.value, SensorValue::Text(ref v) if v == "connected"));
        // A late-opened studio (wildcard) gets it too; an unconfigured HA is reported as such.
        let star = ["*".to_string()];
        let s = prime_status_sample(Some("unconfigured"), &star, 9).expect("primed");
        assert!(matches!(s.value, SensorValue::Text(ref v) if v == "unconfigured"));
        // No status ever emitted → nothing made up; a window not wanting ha.status → nothing.
        assert!(prime_status_sample(None, &wants_status, 9).is_none());
        let entity_only = ["ha.light.a".to_string(), "cpu.total".to_string()];
        assert!(prime_status_sample(Some("connected"), &entity_only, 9).is_none());
    }

    #[test]
    fn ha_state_remembers_latest_and_forgets_removed_entities() {
        let state = HaState::default();
        state.remember("light.a", &json!({"state": "on"}));
        state.remember("light.a", &json!({"state": "off"}));
        assert_eq!(
            state.latest.lock().unwrap()["light.a"]["state"],
            json!("off")
        );
        state.remember("light.a", &Value::Null); // entity removed
        assert!(state.latest.lock().unwrap().is_empty());
    }

    #[test]
    fn art_chunks_are_capped_at_the_max_body_size() {
        let mut buf = Vec::new();
        assert!(accept_art_chunk(&mut buf, &[1, 2, 3], 4).is_ok());
        // Exactly at the cap is fine; one byte over is refused and the buffer is left as it was.
        assert!(accept_art_chunk(&mut buf, &[4], 4).is_ok());
        let err = accept_art_chunk(&mut buf, &[5], 4).unwrap_err();
        assert!(err.contains("exceeds 4 bytes"), "{err}");
        assert_eq!(buf, vec![1, 2, 3, 4]);
    }

    #[test]
    fn valid_entity_id_accepts_slugs_rejects_injection() {
        assert!(valid_entity_id("sensor.cpu_temp"));
        assert!(valid_entity_id("binary_sensor.front_door"));
        assert!(valid_entity_id("input_number.x1"));
        assert!(!valid_entity_id("x/api/admin"));
        assert!(!valid_entity_id("../etc"));
        assert!(!valid_entity_id("a.b.c"));
        assert!(!valid_entity_id(""));
        assert!(!valid_entity_id("sensor."));
        assert!(!valid_entity_id("Sensor.X")); // uppercase is not a slug
    }

    #[test]
    fn valid_art_path_requires_host_absolute_no_traversal() {
        assert!(valid_art_path(
            "/api/media_player_proxy/media_player.x?token=abc&cache=1"
        ));
        assert!(!valid_art_path("http://evil/x")); // not host-absolute
        assert!(!valid_art_path("//evil/x")); // protocol-relative
        assert!(!valid_art_path("/a/../../etc")); // traversal
        assert!(!valid_art_path("/a b")); // whitespace
        assert!(!valid_art_path(""));
    }

    #[test]
    fn iso8601_parses_to_ms_as_utc() {
        assert_eq!(iso8601_to_ms("1970-01-01T00:00:00+00:00"), Some(0));
        assert_eq!(
            iso8601_to_ms("2021-01-01T00:00:00.000+00:00"),
            Some(1_609_459_200_000)
        );
        // fractional seconds → ms (first 3 digits)
        assert_eq!(
            iso8601_to_ms("2021-01-01T00:00:00.789012+00:00"),
            Some(1_609_459_200_789)
        );
        assert_eq!(
            iso8601_to_ms("2021-01-01T00:00:00.5Z"),
            Some(1_609_459_200_500)
        );
        assert_eq!(iso8601_to_ms("not-a-date"), None);
        assert_eq!(iso8601_to_ms("2021-13-01T00:00:00Z"), None);
    }

    #[test]
    fn history_to_samples_keeps_numeric_only_with_ts() {
        let hist = json!([
            { "state": "21.6", "last_changed": "2021-01-01T00:00:00+00:00" },
            { "state": "unavailable", "last_changed": "2021-01-01T00:01:00+00:00" },
            { "state": "22.0", "last_updated": "2021-01-01T00:02:00+00:00" }
        ]);
        let samples = history_to_samples("sensor.temp", &hist);
        assert_eq!(samples.len(), 2);
        assert_eq!(samples[0].sensor, "ha.sensor.temp.state");
        assert_eq!(samples[0].ts_ms, 1_609_459_200_000);
        assert!(matches!(samples[0].value, SensorValue::Scalar(v) if (v - 21.6).abs() < 1e-9));
        // the second numeric row falls back to last_updated for its ts
        assert_eq!(samples[1].ts_ms, 1_609_459_320_000);
    }

    #[test]
    fn history_to_samples_empty_on_non_array() {
        assert!(history_to_samples("sensor.x", &Value::Null).is_empty());
        assert!(history_to_samples("sensor.x", &json!([])).is_empty());
    }

    #[test]
    fn ws_url_maps_scheme_and_appends_path() {
        assert_eq!(
            ws_url_from("http://homeassistant.local:8123", ""),
            "ws://homeassistant.local:8123/api/websocket"
        );
        assert_eq!(
            ws_url_from("https://ha.example.com", ""),
            "wss://ha.example.com/api/websocket"
        );
    }

    #[test]
    fn ws_url_strips_trailing_slash_and_passes_ws_schemes() {
        assert_eq!(
            ws_url_from("http://ha:8123/", ""),
            "ws://ha:8123/api/websocket"
        );
        assert_eq!(
            ws_url_from("ws://ha:8123", ""),
            "ws://ha:8123/api/websocket"
        );
        assert_eq!(
            ws_url_from("wss://ha:8123/", ""),
            "wss://ha:8123/api/websocket"
        );
        // No scheme defaults to ws://.
        assert_eq!(ws_url_from("ha:8123", ""), "ws://ha:8123/api/websocket");
    }

    #[test]
    fn ws_url_and_rest_base_apply_a_reverse_proxy_subpath() {
        // Base path is normalized (leading slash, no trailing) and inserted before /api/...
        assert_eq!(
            ws_url_from("https://h", "homeassistant"),
            "wss://h/homeassistant/api/websocket"
        );
        assert_eq!(
            ws_url_from("https://h/", "/homeassistant/"),
            "wss://h/homeassistant/api/websocket"
        );
        assert_eq!(rest_base("https://h", "ha"), "https://h/ha");
        // Empty base = host root (the common case).
        assert_eq!(rest_base("https://h/", ""), "https://h");
    }

    #[test]
    fn rest_base_strips_trailing_slash() {
        assert_eq!(rest_base("http://ha:8123/", ""), "http://ha:8123");
        assert_eq!(rest_base("http://ha:8123", ""), "http://ha:8123");
    }

    #[test]
    fn numeric_state_emits_json_and_scalar() {
        let st = json!({ "state": "21.6", "attributes": { "unit_of_measurement": "°C" } });
        let samples = state_to_samples("sensor.temp", &st, 7).unwrap();
        assert_eq!(samples.len(), 2);
        assert_eq!(samples[0].sensor, "ha.sensor.temp");
        assert_eq!(samples[1].sensor, "ha.sensor.temp.state");
        let json0 = serde_json::to_value(&samples[0]).unwrap();
        let json1 = serde_json::to_value(&samples[1]).unwrap();
        assert_eq!(json0["value"]["kind"], "json");
        assert_eq!(json1["value"]["kind"], "scalar");
        assert_eq!(json1["value"]["value"], 21.6);
    }

    #[test]
    fn non_numeric_state_emits_json_only() {
        let st = json!({ "state": "unavailable", "attributes": {} });
        let samples = state_to_samples("binary_sensor.x", &st, 0).unwrap();
        assert_eq!(samples.len(), 1);
        let v = serde_json::to_value(&samples[0]).unwrap();
        assert_eq!(v["value"]["kind"], "json");

        let on = json!({ "state": "on", "attributes": {} });
        assert_eq!(state_to_samples("switch.x", &on, 0).unwrap().len(), 1);
    }

    #[test]
    fn null_state_emits_nothing() {
        assert!(state_to_samples("sensor.gone", &Value::Null, 0).is_none());
    }

    #[test]
    fn entity_projects_friendly_name_and_unit() {
        let st = json!({
            "entity_id": "sensor.temp",
            "state": "21.4",
            "attributes": { "friendly_name": "Temp", "unit_of_measurement": "°C" }
        });
        let e = entity_from_state(&st).unwrap();
        assert_eq!(e.entity_id, "sensor.temp");
        assert_eq!(e.state, "21.4");
        assert_eq!(e.friendly_name.as_deref(), Some("Temp"));
        assert_eq!(e.unit.as_deref(), Some("°C"));
    }

    #[test]
    fn config_insecure_defaults_false_and_round_trips() {
        // An existing ha.json without `insecure`/`base_path` must still parse (defaults applied).
        let legacy: HaConfig =
            serde_json::from_str(r#"{ "url": "http://ha:8123", "token": "t" }"#).unwrap();
        assert!(!legacy.insecure);
        assert_eq!(legacy.base_path, "");
        // And the opt-ins are honoured when present.
        let optin: HaConfig = serde_json::from_str(
            r#"{ "url": "https://ha:8123", "token": "t", "insecure": true, "base_path": "/ha" }"#,
        )
        .unwrap();
        assert!(optin.insecure);
        assert_eq!(optin.base_path, "/ha");
    }

    #[test]
    fn status_never_serializes_a_token() {
        let v = serde_json::to_value(HaStatus {
            configured: true,
            url: Some("http://ha:8123".to_string()),
            insecure: true,
            base_path: "/ha".to_string(),
        })
        .unwrap();
        assert!(v.get("token").is_none());
        assert_eq!(v["configured"], true);
        assert_eq!(v["url"], "http://ha:8123");
        assert_eq!(v["insecure"], true);
        assert_eq!(v["base_path"], "/ha");
    }

    #[test]
    fn auth_outcome_classifies_handshake_frames() {
        // auth_ok carries the server version.
        let ok = auth_outcome(&json!({ "type": "auth_ok", "ha_version": "2026.6.0" }))
            .unwrap()
            .unwrap();
        assert_eq!(ok.ha_version.as_deref(), Some("2026.6.0"));

        // auth_ok without a version is still a success.
        let ok2 = auth_outcome(&json!({ "type": "auth_ok" }))
            .unwrap()
            .unwrap();
        assert!(ok2.ha_version.is_none());

        // auth_invalid maps to a descriptive error (so the UI can say "bad token").
        let err =
            auth_outcome(&json!({ "type": "auth_invalid", "message": "Invalid access token" }))
                .unwrap()
                .unwrap_err();
        assert!(err.contains("auth_invalid"));
        assert!(err.contains("Invalid access token"));

        // Any other frame → keep reading (None).
        assert!(auth_outcome(&json!({ "type": "auth_required" })).is_none());
        assert!(auth_outcome(&json!({ "type": "result", "id": 1 })).is_none());
    }

    #[test]
    fn registry_projections_map_names_and_relationships() {
        // Area: name present.
        let a = area_from(&json!({ "area_id": "living", "name": "Living Room" })).unwrap();
        assert_eq!(a.area_id, "living");
        assert_eq!(a.name, "Living Room");
        // Area: null name falls back to the id (so the tree always has a label).
        let a2 = area_from(&json!({ "area_id": "x", "name": Value::Null })).unwrap();
        assert_eq!(a2.name, "x");
        assert!(area_from(&json!({ "name": "no id" })).is_none());

        // Device: name_by_user wins over name; area + maker captured.
        let d = device_from(&json!({
            "id": "dev1", "name": "Hue bulb", "name_by_user": "Lamp",
            "area_id": "living", "manufacturer": "Signify", "model": "LCT001"
        }))
        .unwrap();
        assert_eq!(d.id, "dev1");
        assert_eq!(d.name.as_deref(), Some("Lamp"));
        assert_eq!(d.area_id.as_deref(), Some("living"));
        assert_eq!(d.manufacturer.as_deref(), Some("Signify"));
        // Device: no name_by_user → falls back to name; missing area is None.
        let d2 = device_from(&json!({ "id": "dev2", "name": "Sensor" })).unwrap();
        assert_eq!(d2.name.as_deref(), Some("Sensor"));
        assert!(d2.area_id.is_none());
        assert!(device_from(&json!({ "name": "no id" })).is_none());

        // Entity registry: keeps both name + original_name and the device/area links.
        let e = entity_reg_from(&json!({
            "entity_id": "light.kitchen", "device_id": "dev1", "area_id": Value::Null,
            "name": Value::Null, "original_name": "Kitchen", "platform": "hue"
        }))
        .unwrap();
        assert_eq!(e.entity_id, "light.kitchen");
        assert_eq!(e.device_id.as_deref(), Some("dev1"));
        assert!(e.area_id.is_none());
        assert!(e.name.is_none());
        assert_eq!(e.original_name.as_deref(), Some("Kitchen"));
        assert_eq!(e.platform.as_deref(), Some("hue"));
        assert!(entity_reg_from(&json!({ "name": "no id" })).is_none());
    }

    #[test]
    fn test_result_never_serializes_a_token() {
        let v = serde_json::to_value(HaTestResult {
            ha_version: Some("2026.6.0".to_string()),
        })
        .unwrap();
        assert!(v.get("token").is_none());
        assert_eq!(v["ha_version"], "2026.6.0");
    }
}
