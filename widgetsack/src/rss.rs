//! Optional RSS / Atom headlines source — a PEER to weather.rs / stocks.rs. A server-side reqwest
//! poller fetches the configured feed URL on an interval, extracts the item titles + links, and
//! forwards them over the EXISTING `telemetry` event as an `rss.list` JSON sensor (+ `rss.count`), so
//! the unchanged frontend hub ingests them like any other sensor (the RSS widget reads the list).
//!
//! Why a hand-rolled parser (not an XML crate): this app is deliberately lean and a "headlines" widget
//! only needs each item's title + link. The pure `parse_feed_items` seam scans for `<item>` (RSS) /
//! `<entry>` (Atom) blocks and pulls the title (CDATA- + entity-aware) and link — unit-tested without
//! network. Demand-gated (default OFF) like the other external-fetch sources.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::async_runtime::{JoinHandle, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::sensors::{ActiveSensors, SensorSample, SensorValue, TELEMETRY_EVENT};

/// Poll cadence guardrails (seconds). Feeds update slowly, so the floor is generous.
const MIN_INTERVAL: u64 = 300; // 5 min
const MAX_INTERVAL: u64 = 21_600; // 6 h
const IDLE_RECHECK: Duration = Duration::from_secs(5);
const MAX_ITEMS_CAP: u32 = 30;

fn default_interval() -> u64 {
    900 // 15 min
}
fn default_count() -> u32 {
    8
}

/// Server-side RSS config (`plugins/rss.json`). No secrets (public feeds), so all non-secret.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RssConfig {
    #[serde(default)]
    pub url: String,
    #[serde(default = "default_count")]
    pub count: u32,
    /// Optional display name for the feed (shown as the widget header).
    #[serde(default)]
    pub title: String,
    #[serde(default = "default_interval")]
    pub poll_interval_secs: u64,
}

/// What the webview learns about the config (all non-secret). camelCase on the wire.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RssStatus {
    pub configured: bool,
    pub url: String,
    pub count: u32,
    pub title: String,
    pub poll_seconds: u64,
}

/// One headline. Mirrors `FeedItem` in `client/src/lib/core/rss.ts`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FeedItem {
    pub title: String,
    pub link: String,
}

/// Managed state: the running poll task.
#[derive(Default)]
pub struct RssState {
    handle: Mutex<Option<JoinHandle<()>>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- pure seams (unit-tested, no I/O) ----

/// Unescape the handful of XML/HTML entities that show up in feed titles. `&amp;` is done LAST so a
/// double-escaped entity (e.g. `&amp;lt;`) resolves to its single-escaped literal, not past it.
fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// The text content of the FIRST `<tag>…</tag>` in `block`, CDATA-unwrapped + entity-unescaped, or
/// `None` if absent. Skips the opening tag's attributes. Pure.
fn extract_tag(block: &str, tag: &str) -> Option<String> {
    let start = block.find(&format!("<{tag}"))?;
    let gt = block[start..].find('>')? + start;
    let close = format!("</{tag}>");
    let end = block[gt + 1..].find(&close)? + gt + 1;
    let raw = block[gt + 1..end].trim();
    if let Some(inner) = raw
        .strip_prefix("<![CDATA[")
        .and_then(|s| s.strip_suffix("]]>"))
    {
        Some(inner.trim().to_string())
    } else {
        Some(unescape(raw))
    }
}

/// The item link: RSS `<link>URL</link>` first, else an Atom `<link href="URL" …/>`. Empty if neither.
fn extract_link(block: &str) -> String {
    if let Some(url) = extract_tag(block, "link").filter(|u| !u.is_empty()) {
        return url;
    }
    if let Some(i) = block.find("<link")
        && let Some(h) = block[i..].find("href=\"")
    {
        let start = i + h + 6;
        if let Some(end) = block[start..].find('"') {
            return block[start..start + end].to_string();
        }
    }
    String::new()
}

/// Parse up to `max` headline items from an RSS or Atom feed body. RSS uses `<item>`, Atom `<entry>`;
/// the channel/feed title sits OUTSIDE those blocks so it's never picked up. Pure seam — fully tested.
pub fn parse_feed_items(xml: &str, max: usize) -> Vec<FeedItem> {
    let (open, close) = if xml.contains("<item") {
        ("<item", "</item>")
    } else {
        ("<entry", "</entry>")
    };
    let mut out = Vec::new();
    let mut rest = xml;
    while out.len() < max {
        let Some(s) = rest.find(open) else { break };
        let after = &rest[s..];
        let Some(e) = after.find(close) else { break };
        let block = &after[..e];
        if let Some(title) = extract_tag(block, "title").filter(|t| !t.is_empty()) {
            out.push(FeedItem {
                title,
                link: extract_link(block),
            });
        }
        rest = &after[e + close.len()..];
    }
    out
}

/// Build the `rss.*` samples from parsed items. Pure seam.
fn feed_to_samples(items: &[FeedItem], ts: u64) -> Vec<SensorSample> {
    let list = serde_json::to_value(items).unwrap_or(serde_json::Value::Null);
    vec![
        SensorSample {
            sensor: "rss.list".into(),
            ts_ms: ts,
            value: SensorValue::Json(list),
        },
        SensorSample::scalar("rss.count", ts, items.len() as f64),
    ]
}

// ---- config I/O (server-side) ----

fn rss_config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("plugins").join("rss.json"))
}

pub fn load_rss_config<R: Runtime>(app: &AppHandle<R>) -> Result<Option<RssConfig>, String> {
    let path = rss_config_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(txt) => serde_json::from_str(&txt)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

fn has_feed(cfg: &RssConfig) -> bool {
    let u = cfg.url.trim();
    u.starts_with("http://") || u.starts_with("https://")
}

// ---- telemetry emission + demand gate ----

fn emit_status<R: Runtime>(app: &AppHandle<R>, status: &str) {
    let batch = vec![SensorSample::text("rss.status", now_ms(), status)];
    let _ = app.emit(TELEMETRY_EVENT, &batch);
}

/// True while any window is consuming an `rss.*` sensor (an RSS widget is mounted). Default OFF — an
/// all-empty active map (nobody reported yet) must NOT poll the external feed.
fn rss_wanted<R: Runtime>(app: &AppHandle<R>) -> bool {
    let active: State<ActiveSensors> = app.state();
    let guard = active.0.lock().unwrap_or_else(|e| e.into_inner());
    if guard.values().all(|ids| ids.is_empty()) {
        return false;
    }
    crate::sensors::any_wanted(&guard, |id| id.starts_with("rss."))
}

// ---- connection / poll task ----

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("widgetsack/rss")
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

/// Poll the configured feed on the interval, emitting `rss.*` telemetry. Demand-gated: idles (no
/// network) while no RSS widget is mounted, and skips when no feed URL is set. Backs off on failures.
pub async fn run_rss_client<R: Runtime>(app: AppHandle<R>, cfg: RssConfig) {
    let client = match http_client() {
        Ok(c) => c,
        Err(err) => {
            eprintln!("rss: client build failed: {err}");
            emit_status(&app, "error");
            return;
        }
    };
    let interval = Duration::from_secs(cfg.poll_interval_secs.clamp(MIN_INTERVAL, MAX_INTERVAL));
    let url = cfg.url.trim().to_string();
    let max = cfg.count.clamp(1, MAX_ITEMS_CAP) as usize;
    let configured = has_feed(&cfg);
    let timings = app.state::<crate::timings::SubsystemTimings>();

    let mut idle = true;
    let mut fails: u32 = 0;
    loop {
        if !configured || !rss_wanted(&app) {
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
                    // Time the CPU work (parse + emit) only — the fetch above is network wait.
                    let _t = timings.start("plugin.rss");
                    let items = parse_feed_items(&body, max);
                    let _ = app.emit(TELEMETRY_EVENT, &feed_to_samples(&items, now_ms()));
                }
                emit_status(&app, "connected");
                fails = 0;
            }
            Err(err) => {
                eprintln!("rss: fetch {err}");
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

/// Persist `plugins/rss.json` (creates `plugins/`). Studio-window-guarded like the other plugin configs.
#[tauri::command]
pub async fn save_rss_config(
    window: tauri::WebviewWindow,
    app: AppHandle,
    url: String,
    count: u32,
    title: String,
    poll_seconds: u64,
) -> Result<(), String> {
    if window.label() != "studio" {
        return Err("save_rss_config is only allowed from the studio window".into());
    }
    let path = rss_config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let cfg = RssConfig {
        url: url.trim().to_string(),
        count: count.clamp(1, MAX_ITEMS_CAP),
        title,
        poll_interval_secs: poll_seconds.clamp(MIN_INTERVAL, MAX_INTERVAL),
    };
    let txt = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rss_config_status<R: Runtime>(app: AppHandle<R>) -> Result<RssStatus, String> {
    match load_rss_config(&app)? {
        Some(cfg) => Ok(RssStatus {
            configured: has_feed(&cfg),
            url: cfg.url,
            count: cfg.count,
            title: cfg.title,
            poll_seconds: cfg.poll_interval_secs,
        }),
        None => Ok(RssStatus {
            configured: false,
            url: String::new(),
            count: default_count(),
            title: String::new(),
            poll_seconds: default_interval(),
        }),
    }
}

/// Start the poll task if not already running. Idempotent + demand-gated.
#[tauri::command]
pub async fn rss_connect<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, RssState>,
) -> Result<(), String> {
    let cfg = load_rss_config(&app)?.unwrap_or_else(|| RssConfig {
        url: String::new(),
        count: default_count(),
        title: String::new(),
        poll_interval_secs: default_interval(),
    });
    let mut guard = state.handle.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let app_for_task = app.clone();
    *guard = Some(tauri::async_runtime::spawn(async move {
        run_rss_client(app_for_task, cfg).await;
    }));
    Ok(())
}

#[tauri::command]
pub async fn rss_disconnect(state: State<'_, RssState>) -> Result<(), String> {
    if let Some(handle) = state.handle.lock().await.take() {
        handle.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unescape_handles_entities_amp_last() {
        assert_eq!(unescape("Tom &amp; Jerry"), "Tom & Jerry");
        assert_eq!(unescape("a &lt;b&gt; c"), "a <b> c");
        assert_eq!(unescape("&quot;hi&#39;s&quot;"), "\"hi's\"");
        // double-escaped resolves one level (to the single-escaped literal).
        assert_eq!(unescape("&amp;lt;"), "&lt;");
    }

    #[test]
    fn parses_rss_items_with_cdata_and_entities() {
        let xml = r#"<?xml version="1.0"?><rss><channel>
            <title>The Channel Title</title>
            <item><title>First &amp; Foremost</title><link>https://ex.com/1</link></item>
            <item><title><![CDATA[Second <b>story</b>]]></title><link>https://ex.com/2</link></item>
            <item><title>Third</title><link>https://ex.com/3</link></item>
        </channel></rss>"#;
        let items = parse_feed_items(xml, 10);
        assert_eq!(items.len(), 3);
        // The channel title is NOT picked up — only item titles.
        assert_eq!(
            items[0],
            FeedItem {
                title: "First & Foremost".into(),
                link: "https://ex.com/1".into()
            }
        );
        assert_eq!(items[1].title, "Second <b>story</b>"); // CDATA kept literal
        assert_eq!(items[1].link, "https://ex.com/2");
    }

    #[test]
    fn parses_atom_entries_with_href_links() {
        let xml = r#"<feed xmlns="http://www.w3.org/2005/Atom">
            <title>Atom Feed</title>
            <entry><title>Alpha</title><link href="https://ex.com/a" rel="alternate"/></entry>
            <entry><title>Beta</title><link href="https://ex.com/b"/></entry>
        </feed>"#;
        let items = parse_feed_items(xml, 10);
        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0],
            FeedItem {
                title: "Alpha".into(),
                link: "https://ex.com/a".into()
            }
        );
        assert_eq!(items[1].link, "https://ex.com/b");
    }

    #[test]
    fn respects_the_max_and_skips_titleless_items() {
        let xml = "<rss><item><title>A</title></item><item><link>x</link></item><item><title>C</title></item></rss>";
        let items = parse_feed_items(xml, 2);
        assert_eq!(items.len(), 2);
        // The middle item has no title → skipped; "C" fills the second slot.
        assert_eq!(items[0].title, "A");
        assert_eq!(items[1].title, "C");
        assert_eq!(items[0].link, ""); // no link present
    }

    #[test]
    fn feed_to_samples_emits_json_list_and_count() {
        let items = vec![FeedItem {
            title: "X".into(),
            link: "u".into(),
        }];
        let s = feed_to_samples(&items, 5);
        assert_eq!(s[0].sensor, "rss.list");
        assert!(matches!(s[0].value, SensorValue::Json(_)));
        let json = serde_json::to_value(&s[0].value).unwrap();
        assert_eq!(json["kind"], "json");
        assert_eq!(json["value"][0]["title"], "X");
        assert_eq!(s[1].sensor, "rss.count");
    }

    #[test]
    fn has_feed_requires_an_http_url() {
        let mk = |u: &str| RssConfig {
            url: u.into(),
            count: 8,
            title: String::new(),
            poll_interval_secs: 900,
        };
        assert!(has_feed(&mk("https://example.com/feed.xml")));
        assert!(has_feed(&mk("http://lan.local/rss")));
        assert!(!has_feed(&mk("")));
        assert!(!has_feed(&mk("example.com")));
    }

    #[test]
    fn status_serializes_camelcase() {
        let v = serde_json::to_value(RssStatus {
            configured: true,
            url: "https://x/feed".into(),
            count: 8,
            title: "News".into(),
            poll_seconds: 900,
        })
        .unwrap();
        assert_eq!(v["pollSeconds"], 900);
        assert_eq!(v["count"], 8);
    }
}
