//! Optional weather source — a PEER to stocks.rs / mqtt.rs / ha.rs. A server-side reqwest poller hits
//! Open-Meteo's keyless forecast API for the configured location on an interval and forwards the
//! current conditions over the EXISTING `telemetry` event as `weather.*` samples, so the unchanged
//! frontend hub ingests them like any other sensor (the Weather meter binds them via a sensors map).
//!
//! Provider: <https://open-meteo.com> — free, no API key, no signup, generous limits, and CORS-open
//! (but the fetch still lives server-side because the webview CSP blocks external HTTP). No secrets
//! cross the bridge; `WeatherStatus` is fully non-secret.
//!
//! Outer-ring adapter: the pure seams (`open_meteo_url`, `weather_to_samples`) hold the logic and are
//! unit-tested without network.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::async_runtime::{JoinHandle, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::sensors::{ActiveSensors, SensorSample, TELEMETRY_EVENT};

/// Poll cadence guardrails (seconds). Weather changes slowly, so the floor is generous.
const MIN_INTERVAL: u64 = 300; // 5 min — Open-Meteo updates ~every 15 min; don't hammer it
const MAX_INTERVAL: u64 = 21_600; // 6 h
/// While no `weather.*` widget is mounted we don't fetch; re-check the demand gate this often.
const IDLE_RECHECK: Duration = Duration::from_secs(5);

fn default_interval() -> u64 {
    900 // 15 min
}
fn default_unit() -> String {
    "celsius".to_string()
}

/// Server-side weather config (`plugins/weather.json`). Open-Meteo is keyless, so nothing is secret.
/// `#[serde(default)]` everywhere so a partial file parses.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WeatherConfig {
    #[serde(default)]
    pub latitude: f64,
    #[serde(default)]
    pub longitude: f64,
    /// "celsius" | "fahrenheit" — the temperature unit; wind follows (km/h vs mph).
    #[serde(default = "default_unit")]
    pub unit: String,
    #[serde(default = "default_interval")]
    pub poll_interval_secs: u64,
}

/// What the webview learns about the config (all non-secret). camelCase on the wire.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherStatus {
    pub configured: bool,
    pub latitude: f64,
    pub longitude: f64,
    pub unit: String,
    pub poll_seconds: u64,
}

/// Managed state: the running poll task.
#[derive(Default)]
pub struct WeatherState {
    handle: Mutex<Option<JoinHandle<()>>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- config I/O (server-side) ----

fn weather_config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("plugins").join("weather.json"))
}

pub fn load_weather_config<R: Runtime>(app: &AppHandle<R>) -> Result<Option<WeatherConfig>, String> {
    let path = weather_config_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(txt) => serde_json::from_str(&txt).map(Some).map_err(|e| e.to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

/// A location is usable if it isn't the (0,0) null-island default. Pure.
fn has_location(cfg: &WeatherConfig) -> bool {
    cfg.latitude != 0.0 || cfg.longitude != 0.0
}

// ---- pure seams (unit-tested, no I/O) ----

/// The Open-Meteo forecast URL for `lat`/`lon`. `unit` is "fahrenheit" (→ °F + mph wind) or anything
/// else (→ °C + km/h wind). Requests the current conditions + today's high/low.
fn open_meteo_url(lat: f64, lon: f64, unit: &str) -> String {
    let fahrenheit = unit.eq_ignore_ascii_case("fahrenheit");
    let temp_unit = if fahrenheit { "fahrenheit" } else { "celsius" };
    let wind_unit = if fahrenheit { "mph" } else { "kmh" };
    format!(
        "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}\
         &current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m\
         &daily=temperature_2m_max,temperature_2m_min,weather_code&temperature_unit={temp_unit}\
         &wind_speed_unit={wind_unit}&timezone=auto&forecast_days=7"
    )
}

/// Map an Open-Meteo forecast JSON body to `weather.*` telemetry samples. Pure: the caller does the
/// fetch. `unit_letter` ('C'/'F') rides along as `weather.unit` (Text) so the meter can label temps and
/// pick the wind unit. A field that's missing/non-finite is simply skipped (no fabricated value). An
/// unparseable body yields an empty Vec.
fn weather_to_samples(body: &Value, unit_letter: &str, ts_ms: u64) -> Vec<SensorSample> {
    let cur = &body["current"];
    if cur.is_null() {
        return Vec::new();
    }
    let mut out = vec![SensorSample::text("weather.unit", ts_ms, unit_letter)];
    let mut scalar = |id: &str, v: Option<f64>| {
        if let Some(n) = v.filter(|n| n.is_finite()) {
            out.push(SensorSample::scalar(id.to_string(), ts_ms, n));
        }
    };
    scalar("weather.temp", cur["temperature_2m"].as_f64());
    scalar("weather.apparent", cur["apparent_temperature"].as_f64());
    scalar("weather.humidity", cur["relative_humidity_2m"].as_f64());
    scalar("weather.wind", cur["wind_speed_10m"].as_f64());
    scalar("weather.code", cur["weather_code"].as_f64());
    scalar("weather.is_day", cur["is_day"].as_f64());
    scalar("weather.high", body["daily"]["temperature_2m_max"][0].as_f64());
    scalar("weather.low", body["daily"]["temperature_2m_min"][0].as_f64());
    // Multi-day forecast: weather.day.N.{high,low,code} for each day Open-Meteo returned (day 0 = today,
    // duplicating weather.high/low which are kept for back-compat). A short array just yields fewer days.
    let highs = body["daily"]["temperature_2m_max"].as_array();
    let lows = body["daily"]["temperature_2m_min"].as_array();
    let codes = body["daily"]["weather_code"].as_array();
    let days = highs.map_or(0, Vec::len);
    for i in 0..days {
        let at = |arr: Option<&Vec<Value>>| arr.and_then(|a| a.get(i)).and_then(Value::as_f64);
        scalar(&format!("weather.day.{i}.high"), at(highs));
        scalar(&format!("weather.day.{i}.low"), at(lows));
        scalar(&format!("weather.day.{i}.code"), at(codes));
    }
    out
}

/// The single-character unit letter the meter shows ('F' for fahrenheit, else 'C'). Pure.
fn unit_letter(unit: &str) -> &'static str {
    if unit.eq_ignore_ascii_case("fahrenheit") {
        "F"
    } else {
        "C"
    }
}

// ---- telemetry emission + demand gate ----

fn emit_status<R: Runtime>(app: &AppHandle<R>, status: &str) {
    let batch = vec![SensorSample::text("weather.status", now_ms(), status)];
    let _ = app.emit(TELEMETRY_EVENT, &batch);
}

/// True while any window is consuming a `weather.*` sensor (a Weather widget is mounted). Default OFF
/// (like stocks): an all-empty active map — nobody has reported yet — must NOT poll the external API.
fn weather_wanted<R: Runtime>(app: &AppHandle<R>) -> bool {
    let active: State<ActiveSensors> = app.state();
    let guard = active.0.lock().unwrap_or_else(|e| e.into_inner());
    if guard.values().all(|ids| ids.is_empty()) {
        return false;
    }
    crate::sensors::any_wanted(&guard, |id| id.starts_with("weather."))
}

// ---- connection / poll task ----

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

async fn fetch_forecast(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

/// Poll the configured location on the interval, emitting `weather.*` telemetry. Demand-gated: idles
/// (no network) while no Weather widget is mounted, and skips when no location is set. Backs off on
/// consecutive failures. Runs until aborted by `weather_disconnect`.
pub async fn run_weather_client<R: Runtime>(app: AppHandle<R>, cfg: WeatherConfig) {
    let client = match http_client() {
        Ok(c) => c,
        Err(err) => {
            eprintln!("weather: client build failed: {err}");
            emit_status(&app, "error");
            return;
        }
    };
    let interval = Duration::from_secs(cfg.poll_interval_secs.clamp(MIN_INTERVAL, MAX_INTERVAL));
    let url = open_meteo_url(cfg.latitude, cfg.longitude, &cfg.unit);
    let letter = unit_letter(&cfg.unit);
    let located = has_location(&cfg);
    let timings = app.state::<crate::timings::SubsystemTimings>();

    let mut idle = true;
    let mut fails: u32 = 0;
    loop {
        if !located || !weather_wanted(&app) {
            idle = true;
            tokio::time::sleep(IDLE_RECHECK).await;
            continue;
        }
        if idle {
            emit_status(&app, "connecting");
            idle = false;
        }
        match fetch_forecast(&client, &url).await {
            Ok(json) => {
                {
                    // Time the CPU work (parse + emit) only — the fetch above is network wait.
                    let _t = timings.start("plugin.weather");
                    let batch = weather_to_samples(&json, letter, now_ms());
                    if !batch.is_empty() {
                        let _ = app.emit(TELEMETRY_EVENT, &batch);
                    }
                }
                emit_status(&app, "connected");
                fails = 0;
            }
            Err(err) => {
                eprintln!("weather: fetch {err}");
                emit_status(&app, "error");
                fails = (fails + 1).min(5);
            }
        }
        let wait = if fails == 0 {
            interval
        } else {
            interval
                .saturating_mul(1u32 << fails.min(4))
                .min(Duration::from_secs(MAX_INTERVAL))
        };
        tokio::time::sleep(wait).await;
    }
}

// ---- Tauri commands ----

/// Persist `plugins/weather.json` (creates `plugins/`). Studio-window-guarded like the other plugin
/// configs. No secret to preserve (Open-Meteo is keyless), so this is a straight write.
#[tauri::command]
pub async fn save_weather_config(
    window: tauri::WebviewWindow,
    app: AppHandle,
    latitude: f64,
    longitude: f64,
    unit: String,
    poll_seconds: u64,
) -> Result<(), String> {
    if window.label() != "studio" {
        return Err("save_weather_config is only allowed from the studio window".into());
    }
    let path = weather_config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let cfg = WeatherConfig {
        latitude,
        longitude,
        unit: if unit.is_empty() { default_unit() } else { unit },
        poll_interval_secs: poll_seconds.clamp(MIN_INTERVAL, MAX_INTERVAL),
    };
    let txt = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| e.to_string())
}

/// The (non-secret) config.
#[tauri::command]
pub fn weather_config_status<R: Runtime>(app: AppHandle<R>) -> Result<WeatherStatus, String> {
    match load_weather_config(&app)? {
        Some(cfg) => Ok(WeatherStatus {
            configured: has_location(&cfg),
            latitude: cfg.latitude,
            longitude: cfg.longitude,
            unit: cfg.unit,
            poll_seconds: cfg.poll_interval_secs,
        }),
        None => Ok(WeatherStatus {
            configured: false,
            latitude: 0.0,
            longitude: 0.0,
            unit: default_unit(),
            poll_seconds: default_interval(),
        }),
    }
}

/// Start the poll task if not already running. Idempotent. The loop is demand-gated (`weather_wanted`)
/// and skips the network while nothing is mounted / no location is set, so an idle task is cheap.
#[tauri::command]
pub async fn weather_connect<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, WeatherState>,
) -> Result<(), String> {
    let cfg = load_weather_config(&app)?.unwrap_or_else(|| WeatherConfig {
        latitude: 0.0,
        longitude: 0.0,
        unit: default_unit(),
        poll_interval_secs: default_interval(),
    });
    let mut guard = state.handle.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let app_for_task = app.clone();
    *guard = Some(tauri::async_runtime::spawn(async move {
        run_weather_client(app_for_task, cfg).await;
    }));
    Ok(())
}

/// Stop the poll task (if any).
#[tauri::command]
pub async fn weather_disconnect(state: State<'_, WeatherState>) -> Result<(), String> {
    if let Some(handle) = state.handle.lock().await.take() {
        handle.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn url_picks_units_and_carries_coords() {
        let c = open_meteo_url(51.5, -0.12, "celsius");
        assert!(c.contains("latitude=51.5"));
        assert!(c.contains("longitude=-0.12"));
        assert!(c.contains("temperature_unit=celsius"));
        assert!(c.contains("wind_speed_unit=kmh"));
        // Multi-day forecast: a week of daily highs/lows + codes.
        assert!(c.contains("forecast_days=7"));
        assert!(c.contains("weather_code"));
        let f = open_meteo_url(40.0, -74.0, "Fahrenheit");
        assert!(f.contains("temperature_unit=fahrenheit"));
        assert!(f.contains("wind_speed_unit=mph"));
    }

    #[test]
    fn unit_letter_maps_f_else_c() {
        assert_eq!(unit_letter("fahrenheit"), "F");
        assert_eq!(unit_letter("FAHRENHEIT"), "F");
        assert_eq!(unit_letter("celsius"), "C");
        assert_eq!(unit_letter(""), "C");
    }

    #[test]
    fn has_location_rejects_null_island() {
        let at = |la: f64, lo: f64| WeatherConfig {
            latitude: la,
            longitude: lo,
            unit: "celsius".into(),
            poll_interval_secs: 900,
        };
        assert!(!has_location(&at(0.0, 0.0)));
        assert!(has_location(&at(51.5, 0.0)));
        assert!(has_location(&at(0.0, -0.12)));
    }

    fn sample_body() -> Value {
        json!({
            "current": {
                "temperature_2m": 12.3,
                "relative_humidity_2m": 80,
                "apparent_temperature": 10.1,
                "is_day": 1,
                "weather_code": 3,
                "wind_speed_10m": 14.2
            },
            "daily": {
                "temperature_2m_max": [15.0, 17.0, 12.0],
                "temperature_2m_min": [8.0, 9.0, 5.0],
                "weather_code": [3, 61, 0]
            }
        })
    }

    fn find<'a>(s: &'a [SensorSample], id: &str) -> Option<&'a SensorSample> {
        s.iter().find(|x| x.sensor == id)
    }

    #[test]
    fn body_maps_to_current_plus_highlow_plus_unit() {
        let s = weather_to_samples(&sample_body(), "C", 7);
        let v = |id: &str| serde_json::to_value(find(&s, id).unwrap()).unwrap()["value"]["value"].clone();
        assert_eq!(v("weather.temp"), 12.3);
        assert_eq!(v("weather.humidity"), 80.0);
        assert_eq!(v("weather.apparent"), 10.1);
        assert_eq!(v("weather.wind"), 14.2);
        assert_eq!(v("weather.code"), 3.0);
        assert_eq!(v("weather.is_day"), 1.0);
        assert_eq!(v("weather.high"), 15.0);
        assert_eq!(v("weather.low"), 8.0);
        assert_eq!(v("weather.unit"), "C");
    }

    #[test]
    fn daily_arrays_become_per_day_forecast_samples() {
        let s = weather_to_samples(&sample_body(), "C", 0);
        let v = |id: &str| serde_json::to_value(find(&s, id).unwrap()).unwrap()["value"]["value"].clone();
        // Day 0 mirrors today's high/low and carries the code.
        assert_eq!(v("weather.day.0.high"), 15.0);
        assert_eq!(v("weather.day.0.low"), 8.0);
        assert_eq!(v("weather.day.0.code"), 3.0);
        // Subsequent days come straight from the arrays.
        assert_eq!(v("weather.day.1.high"), 17.0);
        assert_eq!(v("weather.day.2.low"), 5.0);
        assert_eq!(v("weather.day.1.code"), 61.0);
        // Only as many days as the arrays provided (3 here) are emitted.
        assert!(find(&s, "weather.day.3.high").is_none());
    }

    #[test]
    fn missing_fields_are_skipped_not_fabricated() {
        let body = json!({ "current": { "temperature_2m": 9.0 }, "daily": {} });
        let s = weather_to_samples(&body, "F", 0);
        assert!(find(&s, "weather.temp").is_some());
        assert!(find(&s, "weather.humidity").is_none());
        assert!(find(&s, "weather.high").is_none());
        // unit always rides along.
        assert_eq!(
            serde_json::to_value(find(&s, "weather.unit").unwrap()).unwrap()["value"]["value"],
            "F"
        );
    }

    #[test]
    fn empty_current_yields_nothing() {
        assert!(weather_to_samples(&json!({ "daily": {} }), "C", 0).is_empty());
    }

    #[test]
    fn status_serializes_camelcase_and_carries_no_secret() {
        let v = serde_json::to_value(WeatherStatus {
            configured: true,
            latitude: 51.5,
            longitude: -0.12,
            unit: "celsius".into(),
            poll_seconds: 900,
        })
        .unwrap();
        assert_eq!(v["pollSeconds"], 900);
        assert_eq!(v["latitude"], 51.5);
        assert!(v.get("api_key").is_none() && v.get("apiKey").is_none());
    }

    #[test]
    fn config_defaults_keep_a_minimal_json_valid() {
        let cfg: WeatherConfig = serde_json::from_str(r#"{ "latitude": 51.5, "longitude": -0.1 }"#).unwrap();
        assert_eq!(cfg.unit, "celsius");
        assert_eq!(cfg.poll_interval_secs, 900);
    }
}
