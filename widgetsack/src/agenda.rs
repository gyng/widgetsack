//! Optional Agenda source — upcoming events from an ICS (iCalendar) feed URL. A PEER to rss.rs: a
//! server-side reqwest poller fetches the `.ics` on an interval, parses the VEVENTs (summary + start),
//! and forwards a minimal ICS snapshot over `telemetry` as the `agenda.calendar` JSON sensor (+
//! `agenda.count`). A frontend worker expands recurrences and timezones. The renderer filters
//! upcoming events and formats local labels. Demand-gated (default OFF).
//!
//! The pure seams (`unfold`, `ics_to_iso`, `parse_ics_events`, `unescape_ics`) hold the logic and are
//! unit-tested without network. DTSTART is reformatted to an ISO-8601 string so the frontend can
//! `new Date()` it directly (JS doesn't parse the ICS basic format); no epoch/leap-year math here.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::sensors::{ActiveSensors, SensorSample, SensorValue, TELEMETRY_EVENT};

const MIN_INTERVAL: u64 = 300; // 5 min
const MAX_INTERVAL: u64 = 21_600; // 6 h
const IDLE_RECHECK: Duration = Duration::from_secs(5);

fn default_interval() -> u64 {
    1800 // 30 min — calendars change slowly
}

/// Server-side agenda config (`plugins/agenda.json`). The `url` IS a secret: a calendar's "private
/// address" embeds an unguessable token that reads the whole calendar, so the file is stored via
/// `secure_config` (DPAPI on Windows — like the HA / LLM / MQTT tokens) and the URL never crosses the
/// bridge back to the webview (the status carries only its host).
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

/// What the webview learns about the config — never the URL itself, only its host. camelCase on the
/// wire; mirrors `AgendaStatus` in `client/src/lib/widgets/plugins/agenda-types.ts`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgendaStatus {
    pub configured: bool,
    /// The saved feed's hostname ('' when unconfigured / unparseable).
    pub host: String,
    pub title: String,
    pub poll_seconds: u64,
}

/// One basic event for the source count and parser tests. The rendered list uses the calendar
/// snapshot from feed_to_samples and a frontend-expanded agenda.list array. `start` is an ISO-8601
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
    task: crate::integration_task::IntegrationTask,
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
    let bytes = v.as_bytes();
    let datetime_length = bytes.len() == 15 || (bytes.len() == 16 && bytes[15] == b'Z');
    if datetime_length && bytes[8] == b'T' {
        let date_ok = bytes[..8].iter().all(u8::is_ascii_digit);
        let time_ok = bytes[9..15].iter().all(u8::is_ascii_digit);
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

// Keep only fields used by the calendar renderer. Private notes, attendee addresses,
// attachments, calendar URLs, and alarms do not cross the bridge.
fn calendar_for_bridge(body: &str) -> String {
    let mut output = String::from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n");
    let mut stack: Vec<String> = Vec::new();
    let mut started = false;
    let mut ended = false;
    let kept = |path: &[String]| {
        if path.len() > 3 {
            return false;
        }
        matches!(
            path.iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .as_slice(),
            ["VCALENDAR", "VEVENT"]
                | ["VCALENDAR", "VTIMEZONE"]
                | ["VCALENDAR", "VTIMEZONE", "STANDARD"]
                | ["VCALENDAR", "VTIMEZONE", "DAYLIGHT"]
        )
    };
    for line in unfold(body) {
        let field = line.split_once(':');
        if let Some((_, name)) = field.filter(|(key, _)| key.eq_ignore_ascii_case("BEGIN")) {
            if stack.is_empty() {
                if started || !name.eq_ignore_ascii_case("VCALENDAR") {
                    return "invalid calendar".into();
                }
                started = true;
            }
            if stack.len() >= 16 {
                return "invalid calendar".into();
            }
            stack.push(name.to_ascii_uppercase());
            if kept(&stack) {
                output.push_str(&format!("BEGIN:{}\r\n", stack.last().unwrap()));
            }
            continue;
        }
        if let Some((_, name)) = field.filter(|(key, _)| key.eq_ignore_ascii_case("END")) {
            if stack
                .last()
                .is_some_and(|last| last.eq_ignore_ascii_case(name))
            {
                if kept(&stack) {
                    output.push_str(&format!("END:{}\r\n", name.to_ascii_uppercase()));
                }
                if stack.len() == 1 {
                    ended = true;
                }
                stack.pop();
            } else {
                return "invalid calendar".into();
            }
            continue;
        }
        if stack.len() > 3 {
            continue;
        }
        let property = line
            .split([';', ':'])
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        let keep = match stack
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .as_slice()
        {
            ["VCALENDAR"] => property == "METHOD",
            ["VCALENDAR", "VEVENT"] => matches!(
                property.as_str(),
                "UID"
                    | "SUMMARY"
                    | "LOCATION"
                    | "DTSTART"
                    | "DTEND"
                    | "DURATION"
                    | "RRULE"
                    | "RDATE"
                    | "EXDATE"
                    | "EXRULE"
                    | "RECURRENCE-ID"
                    | "STATUS"
                    | "SEQUENCE"
                    | "DTSTAMP"
            ),
            ["VCALENDAR", "VTIMEZONE"] => property == "TZID",
            ["VCALENDAR", "VTIMEZONE", "STANDARD"] | ["VCALENDAR", "VTIMEZONE", "DAYLIGHT"] => {
                matches!(
                    property.as_str(),
                    "DTSTART"
                        | "TZOFFSETFROM"
                        | "TZOFFSETTO"
                        | "RRULE"
                        | "RDATE"
                        | "EXDATE"
                        | "TZNAME"
                )
            }
            _ => false,
        };
        if keep {
            output.push_str(&line);
            output.push_str("\r\n");
        }
    }
    if !started || !ended || !stack.is_empty() {
        return "invalid calendar".into();
    }
    output.push_str("END:VCALENDAR\r\n");
    output
}

// The HTTP reader bounds the source body. The worker expands this minimal ICS snapshot,
// preserving timezone and recurrence rules. agenda.count remains the source event count.
fn feed_to_samples(body: &str, ts: u64) -> Vec<SensorSample> {
    let mut samples = agenda_to_samples(&parse_ics_events(body, usize::MAX), ts);
    let calendar = calendar_for_bridge(body);
    let status = if calendar == "invalid calendar" {
        "error"
    } else {
        "connected"
    };
    samples[0].sensor = "agenda.calendar".into();
    samples[0].value = SensorValue::Json(serde_json::json!({ "version": 1, "calendar": calendar }));
    samples.push(SensorSample::text("agenda.status", ts, status));
    samples
}

// ---- config I/O ----

fn agenda_config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("plugins").join("agenda.json"))
}

/// Load the config. `secure_config::read` decrypts a protected file and MIGRATES a legacy plaintext
/// `agenda.json` (written before the URL was treated as a secret) to the protected form on first read.
pub fn load_agenda_config<R: Runtime>(app: &AppHandle<R>) -> Result<Option<AgendaConfig>, String> {
    let path = agenda_config_path(app)?;
    crate::secure_config::read(&path)?
        .map(|txt| serde_json::from_str(&txt).map_err(|e| e.to_string()))
        .transpose()
}

/// The hostname of a feed URL for the status line (`webcal://` normalised like the poller does), or
/// '' when it doesn't parse. Pure — the only part of the URL the webview ever sees.
fn feed_host(url: &str) -> String {
    reqwest::Url::parse(&normalize_url(url))
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default()
}

fn has_feed(cfg: &AgendaConfig) -> bool {
    reqwest::Url::parse(&normalize_url(&cfg.url))
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
}

/// Normalise a webcal:// subscription URL to https:// for the HTTP client. Pure.
fn normalize_url(url: &str) -> String {
    let u = url.trim();
    if let Some((scheme, rest)) = u.split_once("://")
        && scheme.eq_ignore_ascii_case("webcal")
    {
        format!("https://{rest}")
    } else {
        u.to_string()
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
    // Streaming 1 MiB cap (shared with the RSS poller): a calendar is tens of KiB.
    crate::rss::fetch_text_capped(client, url, crate::rss::FEED_BODY_CAP).await
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
                let _t = timings.start("plugin.agenda");
                let batch = feed_to_samples(&body, now_ms());
                let invalid = batch.iter().any(|sample| {
                    sample.sensor == "agenda.status"
                        && matches!(&sample.value, SensorValue::Text(status) if status == "error")
                });
                fails = if invalid { (fails + 1).min(5) } else { 0 };
                let _ = app.emit(TELEMETRY_EVENT, &batch);
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

/// Persist the config (DPAPI-protected). The URL is write-only: a BLANK `url` keeps the previously
/// saved one (the settings field never shows it), mirroring the HA token rule. Studio-only.
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
    let url = url.trim().to_string();
    let url = if url.is_empty() {
        load_agenda_config(&app)?.map(|c| c.url).unwrap_or_default()
    } else {
        url
    };
    let cfg = AgendaConfig {
        url,
        title,
        poll_interval_secs: poll_seconds.clamp(MIN_INTERVAL, MAX_INTERVAL),
    };
    if !has_feed(&cfg) {
        return Err("Enter a valid HTTP, HTTPS, or webcal calendar address".into());
    }
    let txt = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    crate::secure_config::write(&path, &txt)
}

#[tauri::command]
pub async fn agenda_config_status<R: Runtime>(app: AppHandle<R>) -> Result<AgendaStatus, String> {
    // The file read + DPAPI decrypt run on the blocking pool: a sync command would do them on
    // the UI thread, and this is polled by every window's settings/status probe.
    let cfg = tokio::task::spawn_blocking(move || load_agenda_config(&app))
        .await
        .map_err(|e| e.to_string())??;
    match cfg {
        Some(cfg) => Ok(AgendaStatus {
            configured: has_feed(&cfg),
            host: feed_host(&cfg.url),
            title: cfg.title,
            poll_seconds: cfg.poll_interval_secs,
        }),
        None => Ok(AgendaStatus {
            configured: false,
            host: String::new(),
            title: String::new(),
            poll_seconds: default_interval(),
        }),
    }
}

#[tauri::command]
pub async fn agenda_connect<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    app: AppHandle<R>,
    state: State<'_, AgendaState>,
    restart: Option<bool>,
) -> Result<(), String> {
    let restart = restart.unwrap_or(false);
    if restart && window.label() != "studio" {
        return Err("integration restart is only allowed from the studio window".into());
    }
    state
        .task
        .start(restart, || {
            let cfg = load_agenda_config(&app)?.unwrap_or_else(|| AgendaConfig {
                url: String::new(),
                title: String::new(),
                poll_interval_secs: default_interval(),
            });
            let app_for_task = app.clone();

            Ok(Some(async move {
                run_agenda_client(app_for_task, cfg).await;
            }))
        })
        .await
}

#[tauri::command]
pub async fn agenda_disconnect(state: State<'_, AgendaState>) -> Result<(), String> {
    state.task.stop().await;
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
        assert_eq!(
            ics_to_iso("20261231T180000Z"),
            Some(("2026-12-31T18:00:00Z".into(), false))
        );
        assert_eq!(
            ics_to_iso("20261231T093000"),
            Some(("2026-12-31T09:30:00".into(), false))
        );
        assert_eq!(ics_to_iso("garbage"), None);
    }

    #[test]
    fn malformed_date_text_does_not_panic_or_accept_suffixes() {
        for value in [
            "20261231T12345é",
            "20261231T123456garbage",
            "20261231T123456ZZ",
        ] {
            assert_eq!(ics_to_iso(value), None, "{value}");
        }
    }

    #[test]
    fn unescape_ics_decodes_text_escapes() {
        assert_eq!(
            unescape_ics("Lunch with Bob\\, then gym"),
            "Lunch with Bob, then gym"
        );
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
        assert_eq!(
            ev[0],
            AgendaEvent {
                summary: "Standup".into(),
                start: "2026-12-31T09:30:00".into(),
                all_day: false,
                location: "Room 2".into(),
            }
        );
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
    fn invalid_feed_reports_error_instead_of_connected() {
        let samples = feed_to_samples("<html>Not a calendar</html>", 9);
        assert!(samples.iter().any(|sample| sample.sensor == "agenda.status"
            && matches!(&sample.value, SensorValue::Text(status) if status == "error")));
    }

    #[test]
    fn calendar_projection_rejects_missing_or_mismatched_frames_and_excess_depth() {
        for body in [
            "<html>Private page</html>",
            "BEGIN:VCALENDAR\nBEGIN:VEVENT\nEND:VCALENDAR",
            "BEGIN:VCALENDAR",
            "BEGIN:VEVENT\nEND:VEVENT",
            "BEGIN:VCALENDAR\nEND:VCALENDAR\nBEGIN:VCALENDAR\nEND:VCALENDAR",
        ] {
            assert_eq!(calendar_for_bridge(body), "invalid calendar");
        }
        let body = format!("BEGIN:VCALENDAR\n{}", "BEGIN:X\n".repeat(10000));
        assert_eq!(calendar_for_bridge(&body), "invalid calendar");
        assert!(calendar_for_bridge("begin:vcalendar\nbegin:vevent\nsummary:Call\ndtstart:20261014T090000Z\nend:vevent\nend:vcalendar").contains("summary:Call"));
    }

    #[test]
    fn bridge_calendar_preserves_rules_and_zones_without_unused_private_fields() {
        let body = "BEGIN:VCALENDAR\nURL:https://private.example/secret-feed\nBEGIN:VTIMEZONE\nTZID:Europe/London\nBEGIN:DAYLIGHT\nDTSTART:19700329T010000\nTZOFFSETFROM:+0000\nTZOFFSETTO:+0100\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\nEND:DAYLIGHT\nEND:VTIMEZONE\nBEGIN:VEVENT\nUID:weekly\nSUMMARY:Call\nDTSTART;TZID=Europe/London:20261014T093000\nRRULE:FREQ=WEEKLY;COUNT=4\nEXDATE;TZID=Europe/London:20261021T093000\nDESCRIPTION:Private notes\nATTENDEE:mailto:private@example.com\nURL:https://private.example/secret-event\nBEGIN:VALARM\nDESCRIPTION:Private alarm\nEND:VALARM\nEND:VEVENT\nEND:VCALENDAR";
        let samples = feed_to_samples(body, 5);
        let SensorValue::Json(payload) = &samples[0].value else {
            panic!("calendar payload");
        };
        assert_eq!(payload["version"], 1);
        let calendar = payload["calendar"].as_str().expect("calendar text");
        assert!(calendar.contains("RRULE:FREQ=WEEKLY;COUNT=4"));
        assert!(calendar.contains("TZID:Europe/London"));
        assert!(calendar.contains("TZOFFSETTO:+0100"));
        assert!(calendar.contains("EXDATE;TZID=Europe/London:20261021T093000"));
        assert!(!calendar.contains("private"));
        assert!(!calendar.contains("VALARM"));
    }

    #[test]
    fn feed_samples_preserve_future_events_after_a_long_historical_prefix() {
        let mut body = String::from("BEGIN:VCALENDAR\n");
        for i in 0..70 {
            body.push_str(&format!(
                "BEGIN:VEVENT\nSUMMARY:Past {i}\nDTSTART:20200101T100000Z\nEND:VEVENT\n"
            ));
        }
        body.push_str("BEGIN:VEVENT\nSUMMARY:Future meeting\nDTSTART:20300101T100000Z\nEND:VEVENT\nEND:VCALENDAR");
        let samples = feed_to_samples(&body, 9);
        let SensorValue::Json(events) = &samples[0].value else {
            panic!("expected event list");
        };
        let calendar = events["calendar"].as_str().unwrap();
        assert_eq!(parse_ics_events(calendar, usize::MAX).len(), 71);
        assert!(calendar.contains("SUMMARY:Future meeting"));
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
    fn subscription_schemes_are_case_insensitive_like_the_settings_form() {
        let cfg = AgendaConfig {
            url: "WEBCAL://calendar.example/private.ics".into(),
            title: String::new(),
            poll_interval_secs: 300,
        };
        assert!(has_feed(&cfg));
        assert_eq!(
            normalize_url(&cfg.url),
            "https://calendar.example/private.ics"
        );
        assert_eq!(feed_host(&cfg.url), "calendar.example");
    }

    #[test]
    fn normalize_url_rewrites_webcal() {
        assert_eq!(
            normalize_url("webcal://ex.com/cal.ics"),
            "https://ex.com/cal.ics"
        );
        assert_eq!(
            normalize_url("https://ex.com/cal.ics"),
            "https://ex.com/cal.ics"
        );
    }

    #[test]
    fn feed_host_exposes_only_the_hostname() {
        assert_eq!(
            feed_host("https://calendar.google.com/calendar/ical/SECRET-TOKEN/basic.ics"),
            "calendar.google.com"
        );
        assert_eq!(
            feed_host("webcal://cal.example/private/abc.ics"),
            "cal.example"
        );
        assert_eq!(feed_host(""), "");
        assert_eq!(feed_host("not a url"), "");
    }

    #[test]
    fn status_never_serializes_the_url() {
        let status = AgendaStatus {
            configured: true,
            host: "cal.example".into(),
            title: "t".into(),
            poll_seconds: 1800,
        };
        let v = serde_json::to_value(&status).unwrap();
        assert_eq!(v["host"], "cal.example");
        assert!(v.get("url").is_none());
        assert_eq!(v["pollSeconds"], 1800);
    }

    #[test]
    fn has_feed_accepts_http_and_webcal() {
        let mk = |u: &str| AgendaConfig {
            url: u.into(),
            title: String::new(),
            poll_interval_secs: 1800,
        };
        assert!(has_feed(&mk("https://ex.com/c.ics")));
        assert!(has_feed(&mk("webcal://ex.com/c.ics")));
        assert!(!has_feed(&mk("ftp://x")));
        assert!(!has_feed(&mk("")));
    }
}
