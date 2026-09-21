//! Optional MQTT proxy source — a PEER to the Home Assistant source (mqtt.rs ↔ ha.rs), not folded
//! into it: a generic broker has different config (host/port/user/pass/topics) and none of HA's WS
//! handshake. The broker connection + credentials live here, server-side (`plugins/mqtt.json`); the
//! password NEVER crosses the bridge (mirrors `HaStatus`). Topic payloads are forwarded over the
//! EXISTING `telemetry` event as `mqtt.<topic>` samples, so the unchanged frontend hub ingests them
//! like any other sensor. Raw-topic subscription is the primary model; optional HA MQTT Discovery
//! auto-subscribes to discovered state topics and friendly-names them.
//!
//! Outer-ring adapter (like ha.rs): the pure seams (`payload_to_samples`, `parse_discovery`,
//! `topic_to_id`, `is_discovery_config`, `subscription_filters`, `payload_text`,
//! `catalog_insert`) hold the logic and are unit-tested without a broker.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rumqttc::{
    AsyncClient, ClientError, Event, MqttOptions, Packet, QoS, SubscribeFilter, TlsConfiguration,
    Transport,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::async_runtime::{JoinHandle, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::log;
use crate::sensors::{SensorSample, SensorValue, TELEMETRY_EVENT};

/// The conventional HA MQTT discovery topic prefix (`homeassistant/<component>/.../config`).
const DISCOVERY_PREFIX: &str = "homeassistant";

/// rumqttc request-channel depth (client → event loop). Every `subscribe` is one request; the
/// loop below NEVER awaits a send on it (`try_*` only), because the same task drives `poll()` —
/// a blocking send with a full channel would deadlock the loop that drains it.
const REQUEST_CAP: usize = 32;

/// Payloads above this are dropped (not forwarded as text): a camera frame or a firmware blob on a
/// subscribed topic would otherwise be JSON-serialised into every telemetry batch.
const MAX_PAYLOAD_BYTES: usize = 64 * 1024;

/// Upper bound on catalog rows (seen + discovered topics). A `#` subscription on a busy broker can
/// see tens of thousands of distinct topics; the inspector dropdown can't use them and the map
/// would grow without bound. Existing rows still update past the cap; new ones are dropped.
const MAX_CATALOG_ENTRIES: usize = 2000;

fn default_port() -> u16 {
    1883
}

/// Server-side MQTT config. The password stays here + on disk only — never serialized back to the
/// webview (see `MqttStatus`). All optional fields use `#[serde(default)]` so a partial
/// `mqtt.json` parses.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MqttConfig {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub topics: Vec<String>,
    /// Use TLS (port is usually 8883).
    #[serde(default)]
    pub tls: bool,
    /// Accept self-signed / invalid TLS certs (implies TLS). Explicit opt-in, mirrors HA.
    #[serde(default)]
    pub insecure: bool,
    /// Consume HA MQTT Discovery (`homeassistant/#`) — auto-subscribe to discovered state topics.
    #[serde(default)]
    pub discovery: bool,
}

/// What the webview may learn — everything EXCEPT the password.
#[derive(Debug, Serialize)]
pub struct MqttStatus {
    pub configured: bool,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub topics: Vec<String>,
    pub tls: bool,
    pub insecure: bool,
    pub discovery: bool,
}

/// One catalog row (id + optional friendly label/unit) for the inspector dropdown + browser.
#[derive(Clone, Debug, Serialize)]
pub struct MqttCatalogEntry {
    pub id: String, // mqtt.<topic>
    pub topic: String,
    pub label: Option<String>,
    pub unit: Option<String>,
}

/// Managed state: the running client task + a live catalog of seen/discovered topics (read by the
/// `mqtt_catalog` command). The catalog is a plain Mutex map so the command reads it cheaply.
#[derive(Default)]
pub struct MqttState {
    handle: Mutex<Option<JoinHandle<()>>>,
    catalog: Arc<StdMutex<BTreeMap<String, MqttCatalogEntry>>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- config I/O (server-side; password never leaves) ----

fn mqtt_config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("plugins").join("mqtt.json"))
}

pub fn load_mqtt_config<R: Runtime>(app: &AppHandle<R>) -> Result<Option<MqttConfig>, String> {
    let path = mqtt_config_path(app)?;
    crate::secure_config::read(&path)?
        .map(|txt| serde_json::from_str(&txt).map_err(|e| e.to_string()))
        .transpose()
}

// ---- pure seams (unit-tested, no I/O) ----

/// `mqtt.<topic>` — slashes kept verbatim (matches HA's `ha.<entity_id>` keeping dots).
fn topic_to_id(topic: &str) -> String {
    format!("mqtt.{topic}")
}

/// Whether `topic` is a discovery config topic under the prefix (`<prefix>/.../config`).
fn is_discovery_config(topic: &str) -> bool {
    topic.starts_with(&format!("{DISCOVERY_PREFIX}/")) && topic.ends_with("/config")
}

/// Map an MQTT payload to telemetry samples with a STABLE value-kind per id (the rule ha.rs uses to
/// protect sparkline history — a single id never alternates kind):
///   `mqtt.<topic>`        Text(raw)        — always
///   `mqtt.<topic>.value`  Scalar           — when the payload is a bare number
///   `mqtt.<topic>.json`   Json             — when the payload is a JSON object/array
///   `mqtt.<topic>.<key>`  Scalar/Text      — one-level flatten of a JSON object's primitive fields
fn payload_to_samples(topic: &str, payload: &str, ts_ms: u64) -> Vec<SensorSample> {
    let base = topic_to_id(topic);
    let mut out = vec![SensorSample {
        sensor: base.clone(),
        ts_ms,
        value: SensorValue::Text(payload.to_string()),
    }];
    if let Ok(n) = payload.trim().parse::<f64>() {
        out.push(SensorSample::scalar(format!("{base}.value"), ts_ms, n));
        return out;
    }
    if let Ok(v) = serde_json::from_str::<Value>(payload) {
        if v.is_object() || v.is_array() {
            out.push(SensorSample {
                sensor: format!("{base}.json"),
                ts_ms,
                value: SensorValue::Json(v.clone()),
            });
        }
        if let Some(obj) = v.as_object() {
            for (k, val) in obj {
                let id = format!("{base}.{k}");
                if let Some(n) = val.as_f64() {
                    out.push(SensorSample::scalar(id, ts_ms, n));
                } else if let Some(s) = val.as_str() {
                    out.push(SensorSample {
                        sensor: id,
                        ts_ms,
                        value: SensorValue::Text(s.to_string()),
                    });
                } else if let Some(b) = val.as_bool() {
                    out.push(SensorSample {
                        sensor: id,
                        ts_ms,
                        value: SensorValue::Text(b.to_string()),
                    });
                }
            }
        }
    }
    out
}

/// A discovered HA-MQTT entity (from a retained `<prefix>/<component>/.../config` payload).
#[derive(Clone, Debug, PartialEq)]
struct Discovered {
    state_topic: String,
    name: Option<String>,
    unit: Option<String>,
}

/// Parse a discovery `config` payload. HA uses both full and abbreviated keys; support both:
/// `state_topic`/`stat_t`, `name`, `unit_of_measurement`/`unit_of_meas`. `None` without a state topic.
fn parse_discovery(payload: &str) -> Option<Discovered> {
    let v: Value = serde_json::from_str(payload).ok()?;
    let state_topic = v["state_topic"]
        .as_str()
        .or_else(|| v["stat_t"].as_str())?
        .to_string();
    let name = v["name"].as_str().map(String::from);
    let unit = v["unit_of_measurement"]
        .as_str()
        .or_else(|| v["unit_of_meas"].as_str())
        .map(String::from);
    Some(Discovered {
        state_topic,
        name,
        unit,
    })
}

/// A concrete (no wildcard) topic that can be seeded into the catalog before any publish arrives.
fn is_concrete_topic(topic: &str) -> bool {
    !topic.contains('+') && !topic.contains('#')
}

/// The ONE subscribe request sent on every ConnAck: the configured topics (blank + duplicate
/// entries dropped) plus the discovery wildcard when enabled. Batched so a 100-topic config is a
/// single request on the bounded channel instead of 100 (which would exceed `REQUEST_CAP`).
fn subscription_filters(topics: &[String], discovery: bool) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for t in topics {
        let t = t.trim();
        if !t.is_empty() && seen.insert(t) {
            out.push(t.to_string());
        }
    }
    if discovery {
        let wildcard = format!("{DISCOVERY_PREFIX}/#");
        if seen.insert(wildcard.as_str()) {
            out.push(wildcard.clone());
        }
    }
    out
}

/// The text sample for a payload: `None` (skip the publish) when it is over `MAX_PAYLOAD_BYTES` or
/// not valid UTF-8 (binary — a lossy transcode would be garbage in a Text meter anyway).
fn payload_text(bytes: &[u8]) -> Option<String> {
    if bytes.len() > MAX_PAYLOAD_BYTES {
        return None;
    }
    std::str::from_utf8(bytes).ok().map(str::to_string)
}

/// Insert `entry` under `topic` unless the catalog is at `cap` and the topic is new. `replace`
/// overwrites an existing row (a discovery config brings a friendly label); otherwise an existing row
/// is kept (`or_insert` semantics). Returns whether the row is now present.
fn catalog_insert(
    cat: &mut BTreeMap<String, MqttCatalogEntry>,
    topic: &str,
    entry: MqttCatalogEntry,
    replace: bool,
    cap: usize,
) -> bool {
    if let Some(existing) = cat.get_mut(topic) {
        if replace {
            *existing = entry;
        }
        return true;
    }
    if cat.len() >= cap {
        return false;
    }
    cat.insert(topic.to_string(), entry);
    true
}

/// Queue a subscribe for `topic` without ever awaiting the request channel (see `REQUEST_CAP`):
/// `true` on success; `false` if the channel is full (the caller keeps the topic pending and
/// retries after the next `poll()` drains a request).
fn try_subscribe_many(client: &AsyncClient, topics: &[String]) -> bool {
    if topics.is_empty() {
        return true;
    }
    let filters = topics
        .iter()
        .map(|t| SubscribeFilter::new(t.clone(), QoS::AtMostOnce));
    match client.try_subscribe_many(filters) {
        Ok(()) => true,
        Err(ClientError::TryRequest(_)) => false,
        Err(err) => {
            log::warn("mqtt", "subscribe rejected")
                .field("error", err)
                .field("count", topics.len())
                .emit();
            true // invalid filters: nothing to retry
        }
    }
}

// ---- telemetry emission ----

/// Surface the connection state to widgets as an `mqtt.status` text sample (a Text meter bound to
/// `mqtt.status` shows it) — mirrors ha.rs's single-status-transport design.
fn emit_status<R: Runtime>(app: &AppHandle<R>, status: &str) {
    let batch = vec![SensorSample {
        sensor: "mqtt.status".to_string(),
        ts_ms: now_ms(),
        value: SensorValue::Text(status.to_string()),
    }];
    let _ = app.emit(TELEMETRY_EVENT, &batch);
}

// ---- connection task ----

/// Reconnecting MQTT client loop. rumqttc's EventLoop reconnects on the next `poll()` after a
/// drop, so the loop simply keeps polling; on each ConnAck it (re)subscribes (subscriptions are
/// per-connection). Runs until the task is aborted by `mqtt_disconnect`.
pub async fn run_mqtt_client<R: Runtime>(
    app: AppHandle<R>,
    cfg: MqttConfig,
    catalog: Arc<StdMutex<BTreeMap<String, MqttCatalogEntry>>>,
) {
    // Seed the catalog with concrete configured topics so the dropdown lists them immediately.
    if let Ok(mut cat) = catalog.lock() {
        for t in cfg.topics.iter().filter(|t| is_concrete_topic(t)) {
            cat.entry(t.clone()).or_insert_with(|| MqttCatalogEntry {
                id: topic_to_id(t),
                topic: t.clone(),
                label: None,
                unit: None,
            });
        }
    }

    let client_id = if cfg.client_id.is_empty() {
        "widgetsack".to_string()
    } else {
        cfg.client_id.clone()
    };
    let mut opts = MqttOptions::new(client_id, &cfg.host, cfg.port);
    opts.set_keep_alive(Duration::from_secs(30));
    opts.set_clean_session(true);
    if !cfg.username.is_empty() {
        opts.set_credentials(cfg.username.clone(), cfg.password.clone());
    }
    if cfg.tls || cfg.insecure {
        let tls = if cfg.insecure {
            // Mirror ha.rs's self-signed path exactly: drop BOTH cert + hostname verification.
            match native_tls::TlsConnector::builder()
                .danger_accept_invalid_certs(true)
                .danger_accept_invalid_hostnames(true)
                .build()
            {
                Ok(c) => TlsConfiguration::NativeConnector(c),
                Err(err) => {
                    log::warn("mqtt", "tls connector failed; using the default connector")
                        .field("error", err)
                        .emit();
                    TlsConfiguration::Native
                }
            }
        } else {
            TlsConfiguration::Native
        };
        opts.set_transport(Transport::tls_with_config(tls));
    }

    let (client, mut eventloop) = AsyncClient::new(opts, REQUEST_CAP);
    emit_status(&app, "connecting");

    // Subscriptions are queued with `try_subscribe_many` — never an awaited `subscribe` — because
    // THIS task also drives `eventloop.poll()`, the only thing that drains the request channel.
    // Anything that doesn't fit (a retained-discovery burst of hundreds of configs) waits in
    // `pending` and is flushed after each poll; `subscribed` dedupes discovered state topics.
    let configured = subscription_filters(&cfg.topics, cfg.discovery);
    let mut pending: Vec<String> = Vec::new();
    let mut subscribed: HashSet<String> = HashSet::new();
    let mut dropped_payloads: u64 = 0;

    loop {
        match eventloop.poll().await {
            Ok(Event::Incoming(Packet::ConnAck(_))) => {
                emit_status(&app, "connected");
                // Subscriptions are per-connection: re-queue everything (configured + discovered).
                subscribed.clear();
                pending.clear();
                pending.extend(configured.iter().cloned());
            }
            Ok(Event::Incoming(Packet::Publish(p))) => {
                let Some(payload) = payload_text(&p.payload) else {
                    dropped_payloads += 1;
                    if dropped_payloads.is_power_of_two() {
                        log::warn("mqtt", "dropped oversized or non-UTF-8 payload")
                            .field("topic", &p.topic)
                            .field("bytes", p.payload.len())
                            .field("dropped_total", dropped_payloads)
                            .emit();
                    }
                    continue;
                };
                // Discovery config: register + subscribe to the entity's state topic (don't emit it).
                if cfg.discovery && is_discovery_config(&p.topic) {
                    if let Some(d) = parse_discovery(&payload) {
                        if !subscribed.contains(&d.state_topic) && !pending.contains(&d.state_topic)
                        {
                            pending.push(d.state_topic.clone());
                        }
                        if let Ok(mut cat) = catalog.lock() {
                            catalog_insert(
                                &mut cat,
                                &d.state_topic,
                                MqttCatalogEntry {
                                    id: topic_to_id(&d.state_topic),
                                    topic: d.state_topic.clone(),
                                    label: d.name,
                                    unit: d.unit,
                                },
                                true,
                                MAX_CATALOG_ENTRIES,
                            );
                        }
                    }
                } else {
                    // Record the seen topic (keeps a discovered entry's friendly label if already set).
                    if let Ok(mut cat) = catalog.lock() {
                        catalog_insert(
                            &mut cat,
                            &p.topic,
                            MqttCatalogEntry {
                                id: topic_to_id(&p.topic),
                                topic: p.topic.clone(),
                                label: None,
                                unit: None,
                            },
                            false,
                            MAX_CATALOG_ENTRIES,
                        );
                    }
                    let batch = payload_to_samples(&p.topic, &payload, now_ms());
                    let _ = app.emit(TELEMETRY_EVENT, &batch);
                }
            }
            Ok(_) => {}
            Err(err) => {
                emit_status(&app, "error");
                log::warn("mqtt", "client error; reconnecting")
                    .field("error", err)
                    .emit();
                // poll() reconnects on the next call; back off so a hard-down broker isn't hammered.
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        }
        // Flush queued subscriptions as ONE request; on a full channel keep them for the next pass
        // (the poll above will have drained at least one request by then).
        if !pending.is_empty() && try_subscribe_many(&client, &pending) {
            subscribed.extend(pending.drain(..));
        }
    }
}

// ---- Tauri commands ----

/// Persist `plugins/mqtt.json` (creates `plugins/`). A blank `password` keeps the saved one
/// (write-only over the bridge, like HA's token).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn save_mqtt_config(
    window: tauri::WebviewWindow,
    app: AppHandle,
    host: String,
    port: u16,
    username: String,
    password: String,
    client_id: String,
    topics: Vec<String>,
    tls: bool,
    insecure: bool,
    discovery: bool,
) -> Result<(), String> {
    if window.label() != "studio" {
        return Err("save_mqtt_config is only allowed from the studio window".into());
    }
    let path = mqtt_config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let password = if password.is_empty() {
        load_mqtt_config(&app)?
            .map(|c| c.password)
            .unwrap_or_default()
    } else {
        password
    };
    let cfg = MqttConfig {
        host,
        port,
        username,
        password,
        client_id,
        topics,
        tls,
        insecure,
        discovery,
    };
    let txt = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    crate::secure_config::write(&path, &txt)
}

/// The non-secret config (everything except the password).
#[tauri::command]
pub async fn mqtt_config_status<R: Runtime>(app: AppHandle<R>) -> Result<MqttStatus, String> {
    // The file read + DPAPI decrypt run on the blocking pool: a sync command would do them on
    // the UI thread, and this is polled by every window's settings/status probe.
    let cfg = tokio::task::spawn_blocking(move || load_mqtt_config(&app))
        .await
        .map_err(|e| e.to_string())??;
    match cfg {
        Some(cfg) => Ok(MqttStatus {
            configured: true,
            host: cfg.host,
            port: cfg.port,
            username: cfg.username,
            topics: cfg.topics,
            tls: cfg.tls,
            insecure: cfg.insecure,
            discovery: cfg.discovery,
        }),
        None => Ok(MqttStatus {
            configured: false,
            host: String::new(),
            port: default_port(),
            username: String::new(),
            topics: Vec::new(),
            tls: false,
            insecure: false,
            discovery: false,
        }),
    }
}

/// Start the MQTT client iff configured and not already running. Idempotent.
#[tauri::command]
pub async fn mqtt_connect<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, MqttState>,
) -> Result<(), String> {
    let cfg = match load_mqtt_config(&app)? {
        Some(cfg) if !cfg.host.is_empty() => cfg,
        _ => return Ok(()), // not configured: nothing to connect
    };
    let mut guard = state.handle.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let app_for_task = app.clone();
    let catalog = state.catalog.clone();
    *guard = Some(tauri::async_runtime::spawn(async move {
        run_mqtt_client(app_for_task, cfg, catalog).await;
    }));
    Ok(())
}

/// Stop the MQTT client (if any).
#[tauri::command]
pub async fn mqtt_disconnect(state: State<'_, MqttState>) -> Result<(), String> {
    if let Some(handle) = state.handle.lock().await.take() {
        handle.abort();
    }
    Ok(())
}

/// The catalog of seen + discovered topics (id + friendly label + unit) for the inspector dropdown.
#[tauri::command]
pub fn mqtt_catalog(state: State<'_, MqttState>) -> Result<Vec<MqttCatalogEntry>, String> {
    let cat = state.catalog.lock().map_err(|e| e.to_string())?;
    Ok(cat.values().cloned().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn topic_id_keeps_slashes() {
        assert_eq!(topic_to_id("zigbee2mqtt/sensor"), "mqtt.zigbee2mqtt/sensor");
    }

    #[test]
    fn payload_text_always_plus_scalar_for_numbers() {
        let s = payload_to_samples("t/a", "42.5", 7);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].sensor, "mqtt.t/a");
        let v0 = serde_json::to_value(&s[0]).unwrap();
        assert_eq!(v0["value"]["kind"], "text"); // base id is ALWAYS text (stable kind)
        let v1 = serde_json::to_value(&s[1]).unwrap();
        assert_eq!(s[1].sensor, "mqtt.t/a.value");
        assert_eq!(v1["value"]["kind"], "scalar");
        assert_eq!(v1["value"]["value"], 42.5);
    }

    #[test]
    fn payload_plain_text_emits_only_base() {
        let s = payload_to_samples("t/a", "online", 0);
        assert_eq!(s.len(), 1);
        let v = serde_json::to_value(&s[0]).unwrap();
        assert_eq!(v["value"]["kind"], "text");
        assert_eq!(v["value"]["value"], "online");
    }

    #[test]
    fn payload_json_emits_json_and_flattens_primitives() {
        let s = payload_to_samples("t/dev", r#"{"temp":21.4,"name":"x","on":true}"#, 0);
        let ids: Vec<&str> = s.iter().map(|x| x.sensor.as_str()).collect();
        assert!(ids.contains(&"mqtt.t/dev")); // raw text base
        assert!(ids.contains(&"mqtt.t/dev.json")); // full json
        assert!(ids.contains(&"mqtt.t/dev.temp")); // numeric field → scalar
        assert!(ids.contains(&"mqtt.t/dev.name")); // string field → text
        assert!(ids.contains(&"mqtt.t/dev.on")); // bool field → text
        let temp = s.iter().find(|x| x.sensor == "mqtt.t/dev.temp").unwrap();
        assert_eq!(
            serde_json::to_value(temp).unwrap()["value"]["kind"],
            "scalar"
        );
    }

    #[test]
    fn discovery_config_topic_detection() {
        assert!(is_discovery_config("homeassistant/sensor/x/config"));
        assert!(!is_discovery_config("homeassistant/sensor/x/state"));
        assert!(!is_discovery_config("zigbee2mqtt/x/config")); // wrong prefix
    }

    #[test]
    fn parse_discovery_full_and_abbreviated_keys() {
        let full = parse_discovery(
            r#"{"name":"Temp","state_topic":"home/temp","unit_of_measurement":"°C"}"#,
        )
        .unwrap();
        assert_eq!(full.state_topic, "home/temp");
        assert_eq!(full.name.as_deref(), Some("Temp"));
        assert_eq!(full.unit.as_deref(), Some("°C"));

        let abbr = parse_discovery(r#"{"stat_t":"home/t","unit_of_meas":"%"}"#).unwrap();
        assert_eq!(abbr.state_topic, "home/t");
        assert_eq!(abbr.unit.as_deref(), Some("%"));

        // No state topic → not usable.
        assert!(parse_discovery(r#"{"name":"x"}"#).is_none());
    }

    #[test]
    fn status_never_serializes_a_password() {
        let v = serde_json::to_value(MqttStatus {
            configured: true,
            host: "broker".to_string(),
            port: 8883,
            username: "u".to_string(),
            topics: vec!["a/b".to_string()],
            tls: true,
            insecure: false,
            discovery: true,
        })
        .unwrap();
        assert!(v.get("password").is_none());
        assert_eq!(v["host"], "broker");
        assert_eq!(v["port"], 8883);
        assert_eq!(v["discovery"], true);
    }

    #[test]
    fn config_defaults_keep_a_minimal_json_valid() {
        let cfg: MqttConfig = serde_json::from_str(r#"{ "host": "broker" }"#).unwrap();
        assert_eq!(cfg.port, 1883); // default_port
        assert!(!cfg.tls);
        assert!(!cfg.discovery);
        assert!(cfg.topics.is_empty());
    }

    #[test]
    fn concrete_topic_excludes_wildcards() {
        assert!(is_concrete_topic("a/b/c"));
        assert!(!is_concrete_topic("a/+/c"));
        assert!(!is_concrete_topic("a/#"));
    }

    #[test]
    fn discovered_value_kind_is_stable_when_json_then_text() {
        // A topic that sends JSON then a bare string keeps base id as text both times.
        let a = payload_to_samples("t", r#"{"x":1}"#, 0);
        let b = payload_to_samples("t", "idle", 0);
        let kind = |s: &SensorSample| serde_json::to_value(s).unwrap()["value"]["kind"].clone();
        assert_eq!(kind(&a[0]), json!("text"));
        assert_eq!(kind(&b[0]), json!("text"));
    }

    #[test]
    fn subscription_filters_dedupe_trim_and_add_the_discovery_wildcard() {
        let topics = vec![
            "a/b".to_string(),
            " a/b ".to_string(),
            String::new(),
            "c/#".to_string(),
        ];
        assert_eq!(subscription_filters(&topics, false), vec!["a/b", "c/#"]);
        assert_eq!(
            subscription_filters(&topics, true),
            vec!["a/b", "c/#", "homeassistant/#"]
        );
        // A config that already lists the wildcard doesn't get it twice.
        let with = vec!["homeassistant/#".to_string()];
        assert_eq!(subscription_filters(&with, true), vec!["homeassistant/#"]);
        // More topics than the request channel holds still collapse to one batched request.
        let many: Vec<String> = (0..100).map(|i| format!("t/{i}")).collect();
        assert_eq!(subscription_filters(&many, false).len(), 100);
    }

    #[test]
    fn payload_text_caps_size_and_requires_utf8() {
        assert_eq!(payload_text(b"21.5").as_deref(), Some("21.5"));
        assert_eq!(payload_text(b"").as_deref(), Some(""));
        // Exactly the cap is fine; one byte over is dropped.
        assert!(payload_text(&vec![b'x'; MAX_PAYLOAD_BYTES]).is_some());
        assert!(payload_text(&vec![b'x'; MAX_PAYLOAD_BYTES + 1]).is_none());
        // Binary (invalid UTF-8) is dropped rather than lossily transcoded.
        assert!(payload_text(&[0xff, 0xfe, 0x00]).is_none());
    }

    #[test]
    fn catalog_insert_bounds_new_rows_but_still_updates_existing() {
        let entry = |topic: &str, label: Option<&str>| MqttCatalogEntry {
            id: topic_to_id(topic),
            topic: topic.to_string(),
            label: label.map(String::from),
            unit: None,
        };
        let mut cat = BTreeMap::new();
        assert!(catalog_insert(&mut cat, "a", entry("a", None), false, 2));
        assert!(catalog_insert(&mut cat, "b", entry("b", None), false, 2));
        // At the cap: a NEW topic is refused…
        assert!(!catalog_insert(&mut cat, "c", entry("c", None), false, 2));
        assert_eq!(cat.len(), 2);
        // …an existing one is kept (or_insert: label not clobbered by a plain publish)…
        assert!(catalog_insert(
            &mut cat,
            "a",
            entry("a", Some("x")),
            false,
            2
        ));
        assert_eq!(cat["a"].label, None);
        // …and a discovery config (replace) still applies its friendly label.
        assert!(catalog_insert(
            &mut cat,
            "a",
            entry("a", Some("Temp")),
            true,
            2
        ));
        assert_eq!(cat["a"].label.as_deref(), Some("Temp"));
    }
}
