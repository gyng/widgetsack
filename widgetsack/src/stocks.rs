//! Optional stock/crypto quotes source — a PEER to the MQTT + Home Assistant sources
//! (stocks.rs ↔ mqtt.rs ↔ ha.rs). A server-side reqwest poller fetches quotes for the configured
//! symbols on an interval and forwards them over the EXISTING `telemetry` event as `stocks.<SYMBOL>.*`
//! samples, so the unchanged frontend hub ingests them like any other sensor (a Text/Gauge/Sparkline
//! meter — or the bespoke Ticker meter — binds them with no extra wiring).
//!
//! Provider: Yahoo Finance's unofficial `/v8/finance/chart/{symbol}` endpoint — keyless (no signup),
//! and it returns BOTH the latest price AND a same-day intraday series in one call (so the sparkline
//! is real, not synthesized). It is undocumented / ToS-gray and can rate-limit (429) or change shape,
//! so this is deliberately best-effort: failures back off and the last-good value is retained by the
//! hub. The config has a `provider` field (default "yahoo") so a keyed provider can be added later.
//!
//! Outer-ring adapter (like mqtt.rs): the pure seams (`quote_to_samples`, `yahoo_chart_url`,
//! `change_pct`) hold the logic and are unit-tested without network. No secrets cross the bridge
//! (Yahoo needs none); `StocksStatus` is fully non-secret.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::async_runtime::{JoinHandle, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::sensors::{ActiveSensors, SensorSample, SensorValue, TELEMETRY_EVENT};

/// Poll cadence guardrails (seconds). Clamped server-side so a bad config can't hammer the provider.
const MIN_INTERVAL: u64 = 15;
const MAX_INTERVAL: u64 = 3600;
/// While no `stocks.*` widget is mounted we don't fetch; re-check the demand gate this often so a
/// freshly-placed ticker gets data quickly without polling the network when idle.
const IDLE_RECHECK: Duration = Duration::from_secs(3);

fn default_interval() -> u64 {
    60
}
fn default_provider() -> String {
    "yahoo".to_string()
}

/// Server-side stocks config (`plugins/stocks.json`). Yahoo needs no key, so nothing here is secret —
/// but it still lives server-side because the fetch must (the webview CSP blocks external HTTP).
/// `#[serde(default)]` everywhere so a partial file parses.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StocksConfig {
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub symbols: Vec<String>,
    #[serde(default = "default_interval")]
    pub poll_interval_secs: u64,
}

/// What the webview learns about the config (all non-secret). camelCase on the wire.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StocksStatus {
    pub configured: bool,
    pub provider: String,
    pub symbols: Vec<String>,
    pub poll_seconds: u64,
}

/// Managed state: the running poll task.
#[derive(Default)]
pub struct StocksState {
    handle: Mutex<Option<JoinHandle<()>>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- config I/O (server-side) ----

fn stocks_config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("plugins").join("stocks.json"))
}

pub fn load_stocks_config<R: Runtime>(app: &AppHandle<R>) -> Result<Option<StocksConfig>, String> {
    let path = stocks_config_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(txt) => serde_json::from_str(&txt)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

// ---- pure seams (unit-tested, no I/O) ----

/// The Yahoo chart endpoint for `symbol` over `range` at `interval` granularity. `^` (indices, e.g.
/// `^GSPC`) is percent-encoded; plain tickers and `BTC-USD` need no encoding.
fn yahoo_chart_url(symbol: &str, interval: &str, range: &str) -> String {
    let enc = symbol.trim().to_uppercase().replace('^', "%5E");
    format!(
        "https://query1.finance.yahoo.com/v8/finance/chart/{enc}?range={range}&interval={interval}"
    )
}

/// Percent change of `price` vs `prev_close`, or `None` when prev is missing / zero (avoids a /0 and a
/// misleading ±∞ on a brand-new listing).
fn change_pct(price: f64, prev_close: f64) -> Option<f64> {
    if prev_close == 0.0 || !prev_close.is_finite() {
        None
    } else {
        Some((price - prev_close) / prev_close * 100.0)
    }
}

/// Map a Yahoo `/v8/finance/chart` JSON body to telemetry samples for `symbol`. Pure: the caller does
/// the fetch. Emits with a STABLE value-kind per id (a single id never alternates kind, to keep the
/// hub's history ring valid), all under the `stocks.<SYMBOL>.` prefix:
///   `.price`     Scalar  regularMarketPrice (the id the hub accumulates into a sparkline)
///   `.change`    Scalar  % change vs previous close
///   `.changeAbs` Scalar  absolute change vs previous close
///   `.prevClose` Scalar  previous close
///   `.currency`  Text    ISO currency code (USD, …)
///   `.state`     Text    market state (REGULAR | PRE | POST | CLOSED | …)
///   `.series`    Series  same-day intraday closes (nulls dropped) — a REAL sparkline
/// A missing/zero price emits no `.price` (so the meter shows its null state, not a misleading 0); an
/// unparseable / error body yields an empty Vec.
fn quote_to_samples(symbol: &str, chart: &Value, ts_ms: u64) -> Vec<SensorSample> {
    let result = &chart["chart"]["result"][0];
    if result.is_null() {
        return Vec::new();
    }
    let meta = &result["meta"];
    let base = format!("stocks.{}", symbol.trim().to_uppercase());
    let mut out = Vec::new();

    let price = meta["regularMarketPrice"]
        .as_f64()
        .filter(|n| n.is_finite());
    let prev = meta["chartPreviousClose"]
        .as_f64()
        .or_else(|| meta["previousClose"].as_f64())
        .filter(|n| n.is_finite());

    if let Some(p) = price {
        out.push(SensorSample::scalar(format!("{base}.price"), ts_ms, p));
        if let Some(pc) = prev {
            if let Some(pct) = change_pct(p, pc) {
                out.push(SensorSample::scalar(format!("{base}.change"), ts_ms, pct));
            }
            out.push(SensorSample::scalar(
                format!("{base}.changeAbs"),
                ts_ms,
                p - pc,
            ));
        }
    }
    if let Some(pc) = prev {
        out.push(SensorSample::scalar(format!("{base}.prevClose"), ts_ms, pc));
    }
    if let Some(cur) = meta["currency"].as_str() {
        out.push(SensorSample::text(format!("{base}.currency"), ts_ms, cur));
    }
    if let Some(state) = meta["marketState"].as_str() {
        out.push(SensorSample::text(format!("{base}.state"), ts_ms, state));
    }

    if let Some(arr) = result["indicators"]["quote"][0]["close"].as_array() {
        let series: Vec<f64> = arr
            .iter()
            .filter_map(|v| v.as_f64())
            .filter(|n| n.is_finite())
            .collect();
        if series.len() >= 2 {
            out.push(SensorSample {
                sensor: format!("{base}.series"),
                ts_ms,
                value: SensorValue::Series(series),
            });
        }
    }
    out
}

/// The per-symbol field suffixes `quote_to_samples` emits — mirrors `FIELDS` in
/// `client/src/lib/widgets/plugins/stocks-source.ts`. Used to tell a real `stocks.<SYM>.<field>` id
/// apart from the `stocks.status` sentinel when reverse-deriving which symbols are in demand.
const SYMBOL_FIELDS: &[&str] = &[
    "price",
    "change",
    "changeAbs",
    "prevClose",
    "currency",
    "state",
    "series",
];

/// Reverse-derive the uppercased stock symbols implied by a set of active sensor ids. An id shaped
/// `stocks.<SYM>.<field>` (where `<field>` is one we emit) contributes `<SYM>`; the `stocks.status`
/// sentinel, the `*` wildcard, and unrelated sensors are skipped. The symbol is taken with
/// `rsplit_once('.')` so multi-dot tickers (e.g. `BRK.B`) survive intact. De-duped, order-preserving.
/// Pure — the caller supplies the ids.
fn symbols_from_active<'a>(ids: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let Some(rest) = id.strip_prefix("stocks.") else {
            continue;
        };
        let Some((sym, field)) = rest.rsplit_once('.') else {
            continue; // e.g. `stocks.status` — no field, not a symbol
        };
        if !SYMBOL_FIELDS.contains(&field) {
            continue;
        }
        let sym = sym.trim().to_uppercase();
        if !sym.is_empty() && !out.contains(&sym) {
            out.push(sym);
        }
    }
    out
}

/// Union the persisted config symbols with the widget-demanded ones — uppercased, trimmed, de-duped,
/// config first. The fetch list the poll loop actually walks. Pure.
fn merge_symbols(configured: &[String], active: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in configured.iter().chain(active.iter()) {
        let s = s.trim().to_uppercase();
        if !s.is_empty() && !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

// ---- telemetry emission ----

/// Surface the feed state to widgets as a `stocks.status` text sample (a Text meter / the settings
/// badge bind it) — mirrors mqtt.rs / ha.rs's single-status-transport design.
fn emit_status<R: Runtime>(app: &AppHandle<R>, status: &str) {
    let batch = vec![SensorSample::text("stocks.status", now_ms(), status)];
    let _ = app.emit(TELEMETRY_EVENT, &batch);
}

/// True while any window is consuming a `stocks.*` sensor (a ticker is mounted). Lets the poll loop
/// skip the network entirely when nothing is shown — reuses the demand-gating the sensors loop uses.
fn stocks_wanted<R: Runtime>(app: &AppHandle<R>) -> bool {
    let active: State<ActiveSensors> = app.state();
    let guard = active.0.lock().unwrap_or_else(|e| e.into_inner());
    // Unlike system sensors, default OFF: `any_wanted` treats an all-empty map (nobody has reported
    // yet, e.g. at startup before the overlay's first report lands) as "wanted" — which would poll the
    // external API before any ticker exists. Require a real report first.
    if guard.values().all(|ids| ids.is_empty()) {
        return false;
    }
    crate::sensors::any_wanted(&guard, |id| id.starts_with("stocks."))
}

/// The symbols any window is currently demanding (a mounted Ticker subscribes `stocks.<SYM>.*` via
/// the hub; the overlay reports those ids through `set_active_sensors`). Outer-ring wrapper that locks
/// `ActiveSensors` and flattens it into the pure `symbols_from_active` seam.
fn active_stock_symbols<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let active: State<ActiveSensors> = app.state();
    let guard = active.0.lock().unwrap_or_else(|e| e.into_inner());
    symbols_from_active(
        guard
            .values()
            .flat_map(|set| set.iter())
            .map(String::as_str),
    )
}

// ---- connection / poll task ----

/// A reqwest client with a browser-ish User-Agent + timeout. Yahoo's keyless endpoint rejects a bare
/// client (429/401), so a realistic UA is required; this is the ToS-gray part, documented at the top.
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) \
             Chrome/123.0 Safari/537.36",
        )
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

async fn fetch_chart(client: &reqwest::Client, symbol: &str) -> Result<Value, String> {
    let url = yahoo_chart_url(symbol, "2m", "1d");
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("{symbol}: HTTP {}", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

/// Poll the in-demand symbols on the interval, emitting `stocks.*` telemetry. The fetch list is the
/// union of the persisted config and whatever symbols mounted widgets are demanding, recomputed each
/// tick. Demand-gated: when nothing is mounted it idles (no network). Runs until aborted by
/// `stocks_disconnect`.
pub async fn run_stocks_client<R: Runtime>(app: AppHandle<R>, cfg: StocksConfig) {
    let client = match http_client() {
        Ok(c) => c,
        Err(err) => {
            eprintln!("stocks: client build failed: {err}");
            emit_status(&app, "error");
            return;
        }
    };
    let interval = Duration::from_secs(cfg.poll_interval_secs.clamp(MIN_INTERVAL, MAX_INTERVAL));
    // Symbols come from TWO places: the persisted config (`plugins/stocks.json` — for binding
    // `stocks.*` onto Text/Gauge/Sparkline widgets) AND, re-read every tick, whatever a mounted Ticker
    // is actually demanding via the telemetry hub. So dropping a Ticker and typing a symbol "just
    // works" with no separate plugin-list step; a freshly-placed or retargeted ticker is picked up
    // within an interval. We therefore DON'T bail on an empty config here — the loop's per-tick merge
    // (guarded by `stocks_wanted`) decides whether there's anything to fetch.
    let configured: Vec<String> = cfg
        .symbols
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if cfg.provider != "yahoo" {
        eprintln!(
            "stocks: provider '{}' is not implemented; using yahoo",
            cfg.provider
        );
    }

    // `idle` re-emits a fresh "connecting" when a ticker (re)mounts after an idle gap; `fails` drives
    // exponential backoff on consecutive fetch failures so a rate-limited / down provider isn't
    // hammered every interval.
    let timings = app.state::<crate::timings::SubsystemTimings>();
    let mut idle = true;
    let mut fails: u32 = 0;
    loop {
        if !stocks_wanted(&app) {
            idle = true;
            tokio::time::sleep(IDLE_RECHECK).await;
            continue;
        }
        let symbols = merge_symbols(&configured, &active_stock_symbols(&app));
        if symbols.is_empty() {
            // `stocks_wanted` was satisfied only by the studio's `*` wildcard with nothing concrete to
            // fetch yet (no config, no mounted ticker). Idle without touching the network until a real
            // symbol is demanded.
            idle = true;
            tokio::time::sleep(IDLE_RECHECK).await;
            continue;
        }
        if idle {
            emit_status(&app, "connecting");
            idle = false;
        }
        // `fetched` = at least one request SUCCEEDED at the HTTP level, regardless of whether the
        // symbol was known — so an unknown ticker (empty samples) still reads as connected, and only a
        // genuine fetch failure (network / 429) trips "error" + backoff.
        let mut fetched = false;
        for symbol in &symbols {
            match fetch_chart(&client, symbol).await {
                Ok(json) => {
                    fetched = true;
                    // Time the CPU work (parse + emit) only — the fetch above is network wait.
                    let _t = timings.start("plugin.stocks");
                    let batch = quote_to_samples(symbol, &json, now_ms());
                    if !batch.is_empty() {
                        let _ = app.emit(TELEMETRY_EVENT, &batch);
                    }
                }
                Err(err) => eprintln!("stocks: fetch {err}"),
            }
        }
        // Shared status vocabulary (haStatus.ts badge): connecting | connected | error.
        emit_status(&app, if fetched { "connected" } else { "error" });
        fails = if fetched { 0 } else { (fails + 1).min(5) };
        let wait = if fails == 0 {
            interval
        } else {
            // 2× … 16× the interval on a run of failures, capped at 30 min.
            interval
                .saturating_mul(1u32 << fails.min(4))
                .min(Duration::from_secs(1800))
        };
        tokio::time::sleep(wait).await;
    }
}

// ---- Tauri commands ----

/// Persist `plugins/stocks.json` (creates `plugins/`). Studio-window-guarded like the other plugin
/// configs. No secret to preserve (Yahoo is keyless), so this is a straight write.
#[tauri::command]
pub async fn save_stocks_config(
    window: tauri::WebviewWindow,
    app: AppHandle,
    provider: String,
    symbols: Vec<String>,
    poll_seconds: u64,
) -> Result<(), String> {
    if window.label() != "studio" {
        return Err("save_stocks_config is only allowed from the studio window".into());
    }
    let path = stocks_config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let cfg = StocksConfig {
        provider: if provider.is_empty() {
            default_provider()
        } else {
            provider
        },
        symbols,
        poll_interval_secs: poll_seconds.clamp(MIN_INTERVAL, MAX_INTERVAL),
    };
    let txt = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    crate::command::atomic_write(&path, &txt)
}

/// The (non-secret) config.
#[tauri::command]
pub fn stocks_config_status<R: Runtime>(app: AppHandle<R>) -> Result<StocksStatus, String> {
    match load_stocks_config(&app)? {
        Some(cfg) => Ok(StocksStatus {
            configured: cfg.symbols.iter().any(|s| !s.trim().is_empty()),
            provider: cfg.provider,
            symbols: cfg.symbols,
            poll_seconds: cfg.poll_interval_secs,
        }),
        None => Ok(StocksStatus {
            configured: false,
            provider: default_provider(),
            symbols: Vec::new(),
            poll_seconds: default_interval(),
        }),
    }
}

/// Start the poll task if not already running. Idempotent. Starts even with no persisted symbols: a
/// Ticker widget supplies its symbol purely via telemetry demand (`active_stock_symbols`), so the
/// task must be live to pick it up. The loop is demand-gated (`stocks_wanted`) and skips the network
/// while nothing concrete is mounted, so an always-running idle task is cheap.
#[tauri::command]
pub async fn stocks_connect<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, StocksState>,
) -> Result<(), String> {
    let cfg = load_stocks_config(&app)?.unwrap_or_else(|| StocksConfig {
        provider: default_provider(),
        symbols: Vec::new(),
        poll_interval_secs: default_interval(),
    });
    let mut guard = state.handle.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let app_for_task = app.clone();
    *guard = Some(tauri::async_runtime::spawn(async move {
        run_stocks_client(app_for_task, cfg).await;
    }));
    Ok(())
}

/// Stop the poll task (if any).
#[tauri::command]
pub async fn stocks_disconnect(state: State<'_, StocksState>) -> Result<(), String> {
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
    fn url_encodes_caret_and_uppercases() {
        assert_eq!(
            yahoo_chart_url("aapl", "2m", "1d"),
            "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=2m"
        );
        assert!(yahoo_chart_url("^gspc", "2m", "1d").contains("/chart/%5EGSPC?"));
        assert!(yahoo_chart_url("btc-usd", "2m", "1d").contains("/chart/BTC-USD?"));
    }

    #[test]
    fn change_pct_guards_zero_and_nonfinite() {
        assert_eq!(change_pct(110.0, 100.0), Some(10.0));
        assert_eq!(change_pct(90.0, 100.0), Some(-10.0));
        assert_eq!(change_pct(10.0, 0.0), None);
        assert_eq!(change_pct(10.0, f64::NAN), None);
    }

    fn sample_chart() -> Value {
        json!({
            "chart": {
                "result": [{
                    "meta": {
                        "currency": "USD",
                        "symbol": "AAPL",
                        "regularMarketPrice": 110.0,
                        "chartPreviousClose": 100.0,
                        "marketState": "REGULAR"
                    },
                    "indicators": { "quote": [{ "close": [100.0, null, 105.0, 110.0] }] }
                }],
                "error": null
            }
        })
    }

    fn find<'a>(samples: &'a [SensorSample], id: &str) -> Option<&'a SensorSample> {
        samples.iter().find(|s| s.sensor == id)
    }

    #[test]
    fn quote_emits_price_change_currency_state_and_series() {
        let s = quote_to_samples("aapl", &sample_chart(), 7);

        let price = find(&s, "stocks.AAPL.price").unwrap();
        let pv = serde_json::to_value(price).unwrap();
        assert_eq!(pv["value"]["kind"], "scalar");
        assert_eq!(pv["value"]["value"], 110.0);

        let change = find(&s, "stocks.AAPL.change").unwrap();
        assert_eq!(
            serde_json::to_value(change).unwrap()["value"]["value"],
            10.0
        );
        assert_eq!(
            serde_json::to_value(find(&s, "stocks.AAPL.changeAbs").unwrap()).unwrap()["value"]["value"],
            10.0
        );
        assert_eq!(
            serde_json::to_value(find(&s, "stocks.AAPL.currency").unwrap()).unwrap()["value"]["value"],
            "USD"
        );
        assert_eq!(
            serde_json::to_value(find(&s, "stocks.AAPL.state").unwrap()).unwrap()["value"]["value"],
            "REGULAR"
        );

        // The intraday series drops the null and keeps a stable Series kind.
        let series = find(&s, "stocks.AAPL.series").unwrap();
        let sv = serde_json::to_value(series).unwrap();
        assert_eq!(sv["value"]["kind"], "series");
        assert_eq!(sv["value"]["value"], json!([100.0, 105.0, 110.0]));
    }

    #[test]
    fn unknown_symbol_yields_no_samples() {
        let empty = json!({ "chart": { "result": null, "error": { "code": "Not Found" } } });
        assert!(quote_to_samples("nope", &empty, 0).is_empty());
    }

    #[test]
    fn missing_price_emits_no_price_scalar() {
        // A body with prev-close but no regularMarketPrice must not invent a 0 price.
        let body = json!({
            "chart": { "result": [{ "meta": { "chartPreviousClose": 100.0 }, "indicators": {} }] }
        });
        let s = quote_to_samples("x", &body, 0);
        assert!(find(&s, "stocks.X.price").is_none());
        assert!(find(&s, "stocks.X.change").is_none());
        assert!(find(&s, "stocks.X.prevClose").is_some());
    }

    #[test]
    fn symbols_from_active_extracts_symbols_and_skips_sentinels() {
        let ids = [
            "stocks.NVDA.price",
            "stocks.NVDA.change", // duplicate symbol — deduped
            "stocks.AAPL.series",
            "stocks.status",        // status sentinel: not a symbol
            "*",                    // studio wildcard: not a symbol
            "cpu.total",            // unrelated sensor
            "stocks.btc-usd.price", // lowercased -> uppercased; hyphen kept
            "stocks.NVDA.bogus",    // unknown field -> ignored (not a real stocks id)
        ];
        assert_eq!(
            symbols_from_active(ids.iter().copied()),
            vec!["NVDA", "AAPL", "BTC-USD"]
        );
    }

    #[test]
    fn symbols_from_active_keeps_dotted_and_caret_symbols() {
        // Berkshire B (BRK.B) and an index (^GSPC) must survive the field split (rsplit on the LAST
        // dot), so a multi-dot symbol isn't truncated to its first segment.
        let ids = ["stocks.BRK.B.price", "stocks.^GSPC.series"];
        assert_eq!(
            symbols_from_active(ids.iter().copied()),
            vec!["BRK.B", "^GSPC"]
        );
    }

    #[test]
    fn merge_symbols_unions_config_first_uppercased_deduped() {
        let configured = vec!["aapl".to_string(), "MSFT".to_string(), "  ".to_string()];
        let active = vec!["MSFT".to_string(), "nvda".to_string()];
        assert_eq!(
            merge_symbols(&configured, &active),
            vec!["AAPL", "MSFT", "NVDA"]
        );
        // Nothing configured and nothing demanded -> empty (drives the loop's idle-skip guard).
        assert!(merge_symbols(&[], &[]).is_empty());
        // Widget-only demand (the no-plugin-config path this fix enables).
        assert_eq!(merge_symbols(&[], &active), vec!["MSFT", "NVDA"]);
    }

    #[test]
    fn config_defaults_keep_a_minimal_json_valid() {
        let cfg: StocksConfig = serde_json::from_str(r#"{ "symbols": ["AAPL"] }"#).unwrap();
        assert_eq!(cfg.provider, "yahoo");
        assert_eq!(cfg.poll_interval_secs, 60);
    }

    #[test]
    fn status_serializes_camelcase_and_carries_no_secret() {
        let v = serde_json::to_value(StocksStatus {
            configured: true,
            provider: "yahoo".to_string(),
            symbols: vec!["AAPL".to_string()],
            poll_seconds: 60,
        })
        .unwrap();
        assert_eq!(v["pollSeconds"], 60);
        assert_eq!(v["provider"], "yahoo");
        assert!(v.get("api_key").is_none() && v.get("apiKey").is_none());
    }
}
