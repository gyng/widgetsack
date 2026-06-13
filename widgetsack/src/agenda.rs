//! Optional Agenda source — upcoming events from an ICS (iCalendar) feed URL. A PEER to rss.rs: a
//! server-side reqwest poller fetches the `.ics` on an interval, parses the VEVENTs (summary + start),
//! and forwards them over the EXISTING `telemetry` event as an `agenda.list` JSON sensor (+
//! `agenda.count`). The frontend does the upcoming-filtering + friendly time formatting (it has the
//! clock + locale); the backend stays a dumb, dep-free parser. Demand-gated (default OFF).
//!
//! The pure seams (`unfold`, `ics_to_iso`, `parse_ics_events`, `unescape_ics`) hold the logic and are
//! unit-tested without network. DTSTART is reformatted to an ISO-8601 string so the frontend can
//! `new Date()` it directly (JS doesn't parse the ICS basic format); no epoch/leap-year math here.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::async_runtime::{JoinHandle, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::sensors::{ActiveSensors, SensorSample, SensorValue, TELEMETRY_EVENT};

const MIN_INTERVAL: u64 = 300; // 5 min
const MAX_INTERVAL: u64 = 21_600; // 6 h
const IDLE_RECHECK: Duration = Duration::from_secs(5);
/// Parse at most this many events from the feed (the frontend filters to the upcoming few).
const MAX_EVENTS: usize = 60;

fn default_interval() -> u64 {
    1800 // 30 min — calendars change slowly
}

/// Server-side agenda config (`plugins/agenda.json`). No secrets (a feed URL), so all non-secret.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgendaConfig {
    #[serde(default)]
    pub url: String,
    /// Optional display name for the calendar.
    #[serde(default)]
    pub title: String,
    #[serde(default = "default_interval")]
    pub poll_interval_secs: u64,
}

/// What the webview learns about the config. camelCase on the wire.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgendaStatus {
    pub configured: bool,
    pub url: String,
    pub title: String,
    pub poll_seconds: u64,
}

/// One parsed event. Mirrors `AgendaEvent` in `client/src/lib/core/agenda.ts`. `start` is an ISO-8601
/// string (UTC `…Z`, floating, or a date-only `YYYY-MM-DD` for all-day events).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgendaEvent {
    pub summary: String,
    pub start: String,
    pub all_day: bool,
    pub location: String,
}

#[derive(Default)]
pub struct AgendaState {
    handle: Mutex<Option<JoinHandle<()>>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- pure seams (unit-tested, no I/O) ----

/// Unfold ICS content lines: a line beginning with a space or tab is a continuation of the previous
/// one (RFC 5545 folding). Returns the logical lines, CR-stripped. Pure.
fn unfold(ics: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in ics.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if (line.starts_with(' ') || line.starts_with('\t')) && !lines.is_empty() {
            lines.last_mut().unwrap().push_str(&line[1..]);
        } else {
            lines.push(line.to_string());
        }
    }
    lines
}

/// Unescape the RFC-5545 text escapes (`\n` `\,` `\;` `\\`). `\n` becomes a space (single-line display).
fn unescape_ics(s: &str) -> String {
    s.replace("\\n", " ")
        .replace("\\N", " ")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
}

/// The value of property `name` on a content line (`NAME:value` or `NAME;params:value`), or `None` if
/// the line is a different property. Pure.
fn prop_value<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(name)?;
    if !rest.starts_with(':') && !rest.starts_with(';') {
        return None;
    }
    let colon = line.find(':')?;
    Some(&line[colon + 1..])
}

/// Reformat an ICS DTSTART value to ISO-8601 + whether it's an all-day (date-only) event. Handles
/// `YYYYMMDD` (all-day), `YYYYMMDDTHHMMSS` (floating) and `…Z` (UTC). `None` if it isn't one of those.
fn ics_to_iso(value: &str) -> Option<(String, bool)> {
    let v = value.trim();
    if v.len() == 8 && v.bytes().all(|b| b.is_ascii_digit()) {
        return Some((format!("{}-{}-{}", &v[0..4], &v[4..6], &v[6..8]), true));
    }
    if v.len() >= 15 && v.as_bytes()[8] == b'T' {
        let date_ok = v[0..8].bytes().all(|b| b.is_ascii_digit());
        let time_ok = v[9..15].bytes().all(|b| b.is_ascii_digit());
        if date_ok && time_ok {
            let z = if v.ends_with('Z') { "Z" } else { "" };
            return Some((
                format!(
                    "{}-{}-{}T{}:{}:{}{}",
                    &v[0..4],
                    &v[4..6],
                    &v[6..8],
                    &v[9..11],
                    &v[11..13],
                    &v[13..15],
                    z
                ),
                false,
            ));
        }
    }
    None
}

/// Parse up to `max` VEVENTs from an ICS body into agenda events (summary + ISO start). Events with no
/// summary or unparseable start are skipped. Order is feed order; the frontend sorts + filters. Pure.
pub fn parse_ics_events(ics: &str, max: usize) -> Vec<AgendaEvent> {
    let lines = unfold(ics);
    let mut out = Vec::new();
    let mut in_event = false;
    let mut summary = String::new();
    let mut location = String::new();
    let mut start: Option<(String, bool)> = None;
    for line in &lines {
        match line.as_str() {
            "BEGIN:VEVENT" => {
                in_event = true;
                summary.clear();
                location.clear();
                start = None;
            }
            "END:VEVENT" => {
                if in_event
                    && !summary.is_empty()
                    && let Some((s, all_day)) = start.take()
                {
                    out.push(AgendaEvent {
                        summary: unescape_ics(&summary),
                        start: s,
                        all_day,
                        location: unescape_ics(&location),
                    });
                    if out.len() >= max {
                        break;
                    }
                }
                in_event = false;
            }
            _ if in_event => {
                if let Some(v) = prop_value(line, "SUMMARY") {
                    summary = v.to_string();
                } else if let Some(v) = prop_value(line, "LOCATION") {
                    location = v.to_string();
                } else if let Some(v) = prop_value(line, "DTSTART") {
                    start = ics_to_iso(v);
                }
            }
            _ => {}
        }
    }
    out
}

/// Build the `agenda.*` samples from parsed events. Pure seam.
fn agenda_to_samples(events: &[AgendaEvent], ts: u64) -> Vec<SensorSample> {
    let list = serde_json::to_value(events).unwrap_or(serde_json::Value::Null);
    vec![
        SensorSample {
            sensor: "agenda.list".into(),
            ts_ms: ts,
            value: SensorValue::Json(list),
        },
        SensorSample::scalar("agenda.count", ts, events.len() as f64),
    ]
}

// ---- config I/O ----

fn agenda_config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("plugins").join("agenda.json"))
}

pub fn load_agenda_config<R: Runtime>(app: &AppHandle<R>) -> Result<Option<AgendaConfig>, String> {
    let path = agenda_config_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(txt) => serde_json::from_str(&txt).map(Some).map_err(|e| e.to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

fn has_feed(cfg: &AgendaConfig) -> bool {
    let u = cfg.url.trim();
    // webcal:// is the common calendar-subscription scheme; the poller rewrites it to https.
    u.starts_with("http://") || u.starts_with("https://") || u.starts_with("webcal://")
}

/// Normalise a webcal:// subscription URL to https:// for the HTTP client. Pure.
fn normalize_url(url: &str) -> String {
    let u = url.trim();
    match u.strip_prefix("webcal://") {
        Some(rest) => format!("https://{rest}"),
        None => u.to_string(),
    }
}

// ---- telemetry + demand gate ----

fn emit_status<R: Runtime>(app: &AppHandle<R>, status: &str) {
    let batch = vec![SensorSample::text("agenda.status", now_ms(), status)];
    let _ = app.emit(TELEMETRY_EVENT, &batch);
}

fn agenda_wanted<R: Runtime>(app: &AppHandle<R>) -> bool {
    let active: State<ActiveSensors> = app.state();
    let guard = active.0.lock().unwrap_or_else(|e| e.into_inner());
    if guard.values().all(|ids| ids.is_empty()) {
        return false;
    }
    crate::sensors::any_wanted(&guard, |id| id.starts_with("agenda."))
}

// ---- poll task ----

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("widgetsack/agenda")
        .build()
        .map_err(|e| e.to_string())
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

pub async fn run_agenda_client<R: Runtime>(app: AppHandle<R>, cfg: AgendaConfig) {
    let client = match http_client() {
        Ok(c) => c,
        Err(err) => {
            eprintln!("agenda: client build failed: {err}");
            emit_status(&app, "error");
            return;
        }
    };
    let interval = Duration::from_secs(cfg.poll_interval_secs.clamp(MIN_INTERVAL, MAX_INTERVAL));
    let url = normalize_url(&cfg.url);
    let configured = has_feed(&cfg);
    let timings = app.state::<crate::timings::SubsystemTimings>();

    let mut idle = true;
    let mut fails: u32 = 0;
    loop {
        if !configured || !agenda_wanted(&app) {
            idle = true;
            tokio::time::sleep(IDLE_RECHECK).await;
            continue;
        }
        if idle {
            emit_status(&app, "connecting");
            idle = false;
        }
        match fetch_text(&client, &url).await {
            Ok(body) => {
                {
                    let _t = timings.start("plugin.agenda");
                    let events = parse_ics_events(&body, MAX_EVENTS);
                    let _ = app.emit(TELEMETRY_EVENT, &agenda_to_samples(&events, now_ms()));
                }
                emit_status(&app, "connected");
                fails = 0;
            }
            Err(err) => {
                eprintln!("agenda: fetch {err}");
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

// ---- commands ----

#[tauri::command]
pub async fn save_agenda_config(
    window: tauri::WebviewWindow,
    app: AppHandle,
    url: String,
    title: String,
    poll_seconds: u64,
) -> Result<(), String> {
    if window.label() != "studio" {
        return Err("save_agenda_config is only allowed from the studio window".into());
    }
    let path = agenda_config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let cfg = AgendaConfig {
        url: url.trim().to_string(),
        title,
        poll_interval_secs: poll_seconds.clamp(MIN_INTERVAL, MAX_INTERVAL),
    };
    let txt = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agenda_config_status<R: Runtime>(app: AppHandle<R>) -> Result<AgendaStatus, String> {
    match load_agenda_config(&app)? {
        Some(cfg) => Ok(AgendaStatus {
            configured: has_feed(&cfg),
            url: cfg.url,
            title: cfg.title,
            poll_seconds: cfg.poll_interval_secs,
        }),
        None => Ok(AgendaStatus {
            configured: false,
            url: String::new(),
            title: String::new(),
            poll_seconds: default_interval(),
        }),
    }
}

#[tauri::command]
pub async fn agenda_connect<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AgendaState>,
) -> Result<(), String> {
    let cfg = load_agenda_config(&app)?.unwrap_or_else(|| AgendaConfig {
        url: String::new(),
        title: String::new(),
        poll_interval_secs: default_interval(),
    });
    let mut guard = state.handle.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let app_for_task = app.clone();
    *guard = Some(tauri::async_runtime::spawn(async move {
        run_agenda_client(app_for_task, cfg).await;
    }));
    Ok(())
}

#[tauri::command]
pub async fn agenda_disconnect(state: State<'_, AgendaState>) -> Result<(), String> {
    if let Some(handle) = state.handle.lock().await.take() {
        handle.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unfold_joins_continuation_lines() {
        let ics = "SUMMARY:Long event\r\n  that wraps\r\nDTSTART:20261231";
        let lines = unfold(ics);
        assert_eq!(lines[0], "SUMMARY:Long event that wraps");
        assert_eq!(lines[1], "DTSTART:20261231");
    }

    #[test]
    fn ics_to_iso_handles_the_three_forms() {
        assert_eq!(ics_to_iso("20261231"), Some(("2026-12-31".into(), true)));
        assert_eq!(ics_to_iso("20261231T180000Z"), Some(("2026-12-31T18:00:00Z".into(), false)));
        assert_eq!(ics_to_iso("20261231T093000"), Some(("2026-12-31T09:30:00".into(), false)));
        assert_eq!(ics_to_iso("garbage"), None);
    }

    #[test]
    fn unescape_ics_decodes_text_escapes() {
        assert_eq!(unescape_ics("Lunch with Bob\\, then gym"), "Lunch with Bob, then gym");
        assert_eq!(unescape_ics("line1\\nline2"), "line1 line2");
    }

    #[test]
    fn parses_vevents_with_params_and_skips_incomplete() {
        let ics = "BEGIN:VCALENDAR\r\n\
            BEGIN:VEVENT\r\n\
            SUMMARY:Standup\r\n\
            DTSTART;TZID=Europe/London:20261231T093000\r\n\
            LOCATION:Room 2\r\n\
            END:VEVENT\r\n\
            BEGIN:VEVENT\r\n\
            SUMMARY;LANGUAGE=en:All-day off\r\n\
            DTSTART;VALUE=DATE:20270101\r\n\
            END:VEVENT\r\n\
            BEGIN:VEVENT\r\n\
            DTSTART:20270102T100000Z\r\n\
            END:VEVENT\r\n\
            END:VCALENDAR";
        let ev = parse_ics_events(ics, 10);
        assert_eq!(ev.len(), 2); // the third (no SUMMARY) is skipped
        assert_eq!(ev[0], AgendaEvent {
            summary: "Standup".into(),
            start: "2026-12-31T09:30:00".into(),
            all_day: false,
            location: "Room 2".into(),
        });
        assert_eq!(ev[1].summary, "All-day off");
        assert!(ev[1].all_day);
        assert_eq!(ev[1].start, "2027-01-01");
    }

    #[test]
    fn respects_the_max() {
        let mut ics = String::from("BEGIN:VCALENDAR\n");
        for i in 0..5 {
            ics.push_str(&format!(
                "BEGIN:VEVENT\nSUMMARY:E{i}\nDTSTART:2027010{}T100000Z\nEND:VEVENT\n",
                i + 1
            ));
        }
        ics.push_str("END:VCALENDAR");
        assert_eq!(parse_ics_events(&ics, 3).len(), 3);
    }

    #[test]
    fn agenda_to_samples_emits_json_list_and_count() {
        let ev = vec![AgendaEvent {
            summary: "X".into(),
            start: "2027-01-01".into(),
            all_day: true,
            location: String::new(),
        }];
        let s = agenda_to_samples(&ev, 5);
        assert_eq!(s[0].sensor, "agenda.list");
        let json = serde_json::to_value(&s[0].value).unwrap();
        assert_eq!(json["kind"], "json");
        assert_eq!(json["value"][0]["summary"], "X");
        assert_eq!(json["value"][0]["allDay"], true);
        assert_eq!(s[1].sensor, "agenda.count");
    }

    #[test]
    fn normalize_url_rewrites_webcal() {
        assert_eq!(normalize_url("webcal://ex.com/cal.ics"), "https://ex.com/cal.ics");
        assert_eq!(normalize_url("https://ex.com/cal.ics"), "https://ex.com/cal.ics");
    }

    #[test]
    fn has_feed_accepts_http_and_webcal() {
        let mk = |u: &str| AgendaConfig { url: u.into(), title: String::new(), poll_interval_secs: 1800 };
        assert!(has_feed(&mk("https://ex.com/c.ics")));
        assert!(has_feed(&mk("webcal://ex.com/c.ics")));
        assert!(!has_feed(&mk("ftp://x")));
        assert!(!has_feed(&mk("")));
    }
}
