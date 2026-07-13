//! Optional MQTT proxy source — a PEER to the Home Assistant source (mqtt.rs ↔ ha.rs), not folded
//! into it: a generic broker has different config (host/port/user/pass/topics) and none of HA's WS
//! handshake. The broker connection + credentials live here, server-side (`plugins/mqtt.json`); the
//! password NEVER crosses the bridge (mirrors `HaStatus`). Topic payloads are forwarded over the
//! EXISTING `telemetry` event as `mqtt.<topic>` samples, so the unchanged frontend hub ingests them
//! like any other sensor. Raw-topic subscription is the primary model; optional HA MQTT Discovery
//! auto-subscribes to discovered state topics and friendly-names them.
//!
//! Outer-ring adapter (like ha.rs): the pure seams (`payload_to_samples`, `parse_discovery`,
//! `topic_to_id`, `is_discovery_config`) hold the logic and are unit-tested without a broker.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rumqttc::{AsyncClient, Event, MqttOptions, Packet, QoS, TlsConfiguration, Transport};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::async_runtime::{JoinHandle, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::sensors::{SensorSample, SensorValue, TELEMETRY_EVENT};

/// The conventional HA MQTT discovery topic prefix (`homeassistant/<component>/.../config`).
const DISCOVERY_PREFIX: &str = "homeassistant";

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
                    eprintln!("mqtt tls connector failed: {err}");
                    TlsConfiguration::Native
                }
            }
        } else {
            TlsConfiguration::Native
        };
        opts.set_transport(Transport::tls_with_config(tls));
    }

    let (client, mut eventloop) = AsyncClient::new(opts, 32);
    emit_status(&app, "connecting");

    loop {
        match eventloop.poll().await {
            Ok(Event::Incoming(Packet::ConnAck(_))) => {
                emit_status(&app, "connected");
                for t in &cfg.topics {
                    let _ = client.subscribe(t, QoS::AtMostOnce).await;
                }
                if cfg.discovery {
                    let _ = client
                        .subscribe(format!("{DISCOVERY_PREFIX}/#"), QoS::AtMostOnce)
                        .await;
                }
            }
            Ok(Event::Incoming(Packet::Publish(p))) => {
                let payload = String::from_utf8_lossy(&p.payload).to_string();
                // Discovery config: register + subscribe to the entity's state topic (don't emit it).
                if cfg.discovery && is_discovery_config(&p.topic) {
                    if let Some(d) = parse_discovery(&payload) {
                        let _ = client.subscribe(&d.state_topic, QoS::AtMostOnce).await;
                        if let Ok(mut cat) = catalog.lock() {
                            cat.insert(
                                d.state_topic.clone(),
                                MqttCatalogEntry {
                                    id: topic_to_id(&d.state_topic),
                                    topic: d.state_topic.clone(),
                                    label: d.name,
                                    unit: d.unit,
                                },
                            );
                        }
                    }
                    continue;
                }
                // Record the seen topic (keeps a discovered entry's friendly label if already set).
                if let Ok(mut cat) = catalog.lock() {
                    cat.entry(p.topic.clone())
                        .or_insert_with(|| MqttCatalogEntry {
                            id: topic_to_id(&p.topic),
                            topic: p.topic.clone(),
                            label: None,
                            unit: None,
                        });
                }
                let batch = payload_to_samples(&p.topic, &payload, now_ms());
                let _ = app.emit(TELEMETRY_EVENT, &batch);
            }
            Ok(_) => {}
            Err(err) => {
                emit_status(&app, "error");
                eprintln!("mqtt client error: {err}");
                // poll() reconnects on the next call; back off so a hard-down broker isn't hammered.
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
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
pub fn mqtt_config_status<R: Runtime>(app: AppHandle<R>) -> Result<MqttStatus, String> {
    match load_mqtt_config(&app)? {
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
}
