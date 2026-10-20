//! Read-only provider adapters. Secrets never cross the bridge; custom commands are saved-layout
//! gated, bounded and opt-in in Studio. All quota timestamps on our wire are milliseconds.
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::Mutex,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRequest {
    source: String,
    #[serde(default)]
    command: String,
    #[serde(default = "default_env")]
    env: String,
    #[serde(default)]
    account: String,
    #[serde(default = "default_timeout")]
    timeout: u64,
}
fn default_env() -> String {
    "OPENROUTER_API_KEY".into()
}
fn default_timeout() -> u64 {
    20
}
#[derive(Debug)]
struct UsageError {
    message: String,
    cache_for: Duration,
}
impl From<String> for UsageError {
    fn from(message: String) -> Self {
        Self {
            message,
            cache_for: Duration::from_secs(60),
        }
    }
}
impl From<&str> for UsageError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}
fn rate_limit_delay(retry_after: Option<&str>) -> Duration {
    Duration::from_secs(
        retry_after
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(900)
            .max(900),
    )
}
type Cached = Option<(Instant, Duration, Result<Value, String>)>;
type UsageCache = Mutex<HashMap<String, Arc<Mutex<Cached>>>>;
fn metric(id: &str, label: &str, kind: &str, unit: &str, period: &str, scope: &str) -> Value {
    json!({"id":id,"label":label,"kind":kind,"unit":unit,"period":period,"scope":scope})
}
fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}
fn put_number(out: &mut Value, key: &str, value: &Value) {
    if let Some(n) = finite(value) {
        out[key] = json!(n);
    }
}
fn codex_snapshot(limits: &Value, activity: &Value) -> Value {
    let mut metrics = Vec::new();
    let buckets = limits["rateLimitsByLimitId"]
        .as_object()
        .map(|m| m.values().collect::<Vec<_>>())
        .unwrap_or_else(|| vec![&limits["rateLimits"]]);
    for (bucket_index, bucket) in buckets.iter().enumerate() {
        for key in ["primary", "secondary"] {
            let window = &bucket[key];
            let Some(used) = finite(&window["usedPercent"]) else {
                continue;
            };
            let minutes = window["windowDurationMins"].as_u64().unwrap_or(0);
            let (period, label) = match minutes {
                10080 => ("week", "Weekly"),
                300 => ("session", "Session"),
                _ => ("other", "Quota"),
            };
            let bucket_name = bucket["limitName"]
                .as_str()
                .or(bucket["limitId"].as_str())
                .unwrap_or("codex");
            let label = if bucket_name == "codex" {
                label.to_string()
            } else {
                format!("{bucket_name} · {label}")
            };
            let mut m = metric(
                &format!("{bucket_index}-{key}"),
                &label,
                "quota",
                "%",
                period,
                "account",
            );
            m["used"] = json!(used);
            m["limit"] = json!(100);
            if let Some(ts) = finite(&window["resetsAt"]) {
                m["resetsAt"] = json!(ts * 1000.0);
            }
            metrics.push(m);
        }
    }
    if let Some(tokens) = finite(&activity["summary"]["lifetimeTokens"]) {
        let mut m = metric(
            "lifetime-tokens",
            "Tokens",
            "tokens",
            "tokens",
            "lifetime",
            "account",
        );
        m["used"] = json!(tokens);
        metrics.push(m);
    }
    let mut out = json!({"version":1,"metrics":metrics});
    if let Some(n) = limits["rateLimitResetCredits"]["availableCount"].as_u64() {
        out["bankedResets"] = json!({"available":n});
        if let Some(ts) = limits["rateLimitResetCredits"]["credits"]
            .as_array()
            .and_then(|items| items.iter().filter_map(|c| c["expiresAt"].as_u64()).min())
        {
            out["bankedResets"]["expiresAt"] = json!(ts * 1000);
        }
    }
    out
}
fn claude_snapshot(data: &Value) -> Value {
    let mut metrics = Vec::new();
    for (key, label, period) in [
        ("five_hour", "Session", "session"),
        ("seven_day", "Weekly · all models", "week"),
        ("seven_day_sonnet", "Weekly · Sonnet", "week"),
        ("seven_day_opus", "Weekly · Opus", "week"),
    ] {
        let Some(used) = finite(&data[key]["utilization"]) else {
            continue;
        };
        let mut m = metric(key, label, "quota", "%", period, "account");
        m["used"] = json!(used);
        m["limit"] = json!(100);
        // ISO timestamps are decoded by the frontend at this external-data seam.
        if let Some(ts) = data[key]["resets_at"].as_str() {
            m["resetIso"] = json!(ts);
        }
        metrics.push(m);
    }
    let extra = &data["extra_usage"];
    if extra["is_enabled"] == true && finite(&extra["used_credits"]).is_some() {
        let mut m = metric("extra", "Extra usage", "credits", "USD", "month", "account");
        m["used"] = json!(finite(&extra["used_credits"]).unwrap() / 100.0);
        if let Some(limit) = finite(&extra["monthly_limit"]) {
            m["limit"] = json!(limit / 100.0);
        }
        metrics.push(m);
    }
    json!({"version":1,"metrics":metrics,"note":"Claude token totals require a custom command or OMP activity source."})
}
fn openrouter_snapshot(data: &Value, credits: Option<&Value>) -> Value {
    let data = &data["data"];
    let mut metrics = Vec::new();
    for (id, key, period) in [
        ("spend", "usage", "lifetime"),
        ("daily", "usage_daily", "today"),
        ("weekly", "usage_weekly", "week"),
        ("monthly", "usage_monthly", "month"),
    ] {
        if finite(&data[key]).is_some() {
            let mut m = metric(id, "Spend", "credits", "USD", period, "API key");
            put_number(&mut m, "used", &data[key]);
            if id == "spend" {
                put_number(&mut m, "limit", &data["limit"]);
                put_number(&mut m, "remaining", &data["limit_remaining"]);
            }
            metrics.push(m);
        }
    }
    if let Some(c) = credits
        && let (Some(total), Some(used)) = (
            finite(&c["data"]["total_credits"]),
            finite(&c["data"]["total_usage"]),
        )
    {
        let mut m = metric("balance", "Balance", "credits", "USD", "balance", "account");
        m["remaining"] = json!((total - used).max(0.0));
        metrics.push(m);
    }
    json!({"version":1,"metrics":metrics,"note":"Key allowance and account balance are separate. Account balance requires a management key."})
}
fn cli_path(name: &str) -> PathBuf {
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default();
    let known = if name == "codex" {
        local.join("Programs/OpenAI/Codex/bin/codex.exe")
    } else {
        local.join("omp/omp.exe")
    };
    if known.is_file() {
        known
    } else {
        PathBuf::from(format!("{name}.exe"))
    }
}
async fn codex_read() -> Result<Value, String> {
    let mut cmd = tokio::process::Command::new(cli_path("codex"));
    cmd.args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let mut child = cmd
        .spawn()
        .map_err(|_| "Codex CLI could not start. Install it and sign in.".to_string())?;
    #[cfg(windows)]
    let _job =
        crate::studio_agent::ProcessJob::attach(child.id().ok_or("Codex has no process ID")?)?;
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    stdin.write_all(b"{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"widgetsack_usage\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}\n").await.map_err(|e| e.to_string())?;
    let mut limits = None;
    let mut activity = None;
    let result = async {
        loop {
            let mut line = Vec::new();
            // Cap each protocol frame before allocating an unbounded line.
            use tokio::io::AsyncReadExt;
            let n = (&mut stdout).take(1024 * 1024).read_until(b'\n', &mut line).await.map_err(|e| e.to_string())?;
            if n == 0 || line.len() >= 1024 * 1024 { return Err("Codex returned no usable usage response".into()); }
            let value: Value = serde_json::from_slice(&line).map_err(|_| "Invalid Codex response".to_string())?;
            match value["id"].as_u64() {
                Some(1) => { stdin.write_all(b"{\"method\":\"initialized\"}\n{\"id\":2,\"method\":\"account/rateLimits/read\"}\n{\"id\":3,\"method\":\"account/usage/read\"}\n").await.map_err(|e| e.to_string())?; }
                Some(2) => { if value.get("error").is_some() { return Err("Codex usage unavailable. Check CLI sign-in.".into()); } limits = Some(value["result"].clone()); }
                Some(3) => activity = Some(value["result"].clone()),
                _ => {}
            }
            if let (Some(l), Some(a)) = (&limits, &activity) { return Ok(codex_snapshot(l, a)); }
        }
    }.await;
    let _ = child.kill().await;
    result
}
async fn get_json(url: &str, token: &str, claude: bool) -> Result<Value, UsageError> {
    let client = super::http::install_http_client()?;
    let mut request = client.get(url).bearer_auth(token);
    if claude {
        request = request.header("anthropic-beta", "oauth-2025-04-20");
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Provider usage request failed".to_string())?;
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let delay = rate_limit_delay(
            response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok()),
        );
        return Err(UsageError {
            message: format!(
                "Provider usage returned HTTP 429; retry paused for {} minutes",
                delay.as_secs().div_ceil(60)
            ),
            cache_for: delay,
        });
    }
    if !response.status().is_success() {
        return Err(format!("Provider usage returned HTTP {}", response.status()).into());
    }
    let body = super::http::read_body_capped(response).await?;
    serde_json::from_slice(&body).map_err(|_| "Provider returned invalid usage JSON".into())
}
async fn fetch(request: &UsageRequest) -> Result<Value, UsageError> {
    if !request.command.trim().is_empty() || request.source == "command" {
        let result = super::runner::execute(
            &request.command,
            Duration::from_secs(request.timeout.clamp(5, 60)),
        )
        .await?;
        if result.exit_code != Some(0) || result.truncated {
            return Err(
                "Usage command failed or exceeded the output limit. Test it in Studio.".into(),
            );
        }
        return serde_json::from_str(&result.stdout)
            .map_err(|_| "Usage command must print a version 1 JSON object".into());
    }
    match request.source.as_str() {
        "codex" => codex_read().await.map_err(UsageError::from),
        "claude" => {
            let root = std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .ok_or("User profile unavailable")?;
            let raw = tokio::fs::read(root.join(".claude/.credentials.json"))
                .await
                .map_err(|_| {
                    "Claude CLI credentials unavailable. Sign in to Claude Code.".to_string()
                })?;
            let credentials: Value = serde_json::from_slice(&raw)
                .map_err(|_| "Invalid Claude credentials file".to_string())?;
            let token = credentials["claudeAiOauth"]["accessToken"]
                .as_str()
                .ok_or("Claude subscription login not found")?;
            let value = get_json("https://api.anthropic.com/api/oauth/usage", token, true).await?;
            let mut snapshot = claude_snapshot(&value);
            if let Ok((tokens, since)) =
                super::ai_usage_tokens::observed_tokens(root.join(".claude/projects")).await
            {
                let mut m = metric(
                    &format!("observed-tokens-{since}"),
                    "Observed tokens",
                    "tokens",
                    "tokens",
                    "since tracker start",
                    "local CLI",
                );
                m["used"] = json!(tokens);
                snapshot["metrics"].as_array_mut().unwrap().push(m);
            }
            if let Ok(raw) = tokio::fs::read(root.join(".claude/stats-cache.json")).await
                && let Ok(stats) = serde_json::from_slice::<Value>(&raw)
            {
                add_claude_tokens(&mut snapshot, &stats);
            }
            Ok(snapshot)
        }
        "openrouter" => {
            if request.env.len() > 128
                || !request
                    .env
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                return Err("Set an environment variable name for the OpenRouter key".into());
            }
            let token = std::env::var(&request.env)
                .map_err(|_| "OpenRouter key environment variable is not set".to_string())?;
            let key = get_json("https://openrouter.ai/api/v1/key", &token, false).await?;
            let credits = if key["data"]["is_management_key"] == true {
                get_json("https://openrouter.ai/api/v1/credits", &token, false)
                    .await
                    .ok()
            } else {
                None
            };
            Ok(openrouter_snapshot(&key, credits.as_ref()))
        }
        "omp" => {
            let command = if request.account.is_empty() {
                "omp usage --json --redact --no-extensions".to_string()
            } else {
                if !request
                    .account
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                {
                    return Err(
                        "OMP provider id must contain letters, digits, hyphens or underscores"
                            .into(),
                    );
                }
                format!(
                    "omp usage --json --redact --no-extensions --provider {}",
                    request.account
                )
            };
            let result = super::runner::execute(&command, Duration::from_secs(20)).await?;
            if result.exit_code != Some(0) || result.truncated {
                return Err("OMP usage command failed".into());
            }
            let value: Value =
                serde_json::from_str(&result.stdout).map_err(|_| "Invalid OMP usage response")?;
            Ok(omp_snapshot(&value))
        }
        _ => Err("Unknown usage provider".into()),
    }
}
fn omp_snapshot(data: &Value) -> Value {
    let mut metrics = Vec::new();
    if let Some(reports) = data["reports"].as_array() {
        for (i, report) in reports.iter().enumerate() {
            let report = report.get("report").unwrap_or(report);
            if let Some(limits) = report["limits"].as_array() {
                for (j, limit) in limits.iter().enumerate() {
                    let amount = &limit["amount"];
                    if finite(&amount["used"]).is_none()
                        && finite(&amount["remaining"]).is_none()
                        && finite(&amount["usedFraction"]).is_none()
                    {
                        continue;
                    }
                    let raw_unit = amount["unit"].as_str().unwrap_or("units");
                    let unit = match raw_unit {
                        "percent" => "%",
                        "usd" => "USD",
                        other => other,
                    };
                    let kind = match unit {
                        "tokens" => "tokens",
                        "USD" | "usd" | "credits" => "credits",
                        _ => "quota",
                    };
                    let label = limit["label"].as_str().unwrap_or("Usage");
                    let raw_period = limit["window"]["id"].as_str().unwrap_or("other");
                    let period = match raw_period {
                        "5h" => "session",
                        "7d" | "weekly" => "week",
                        other => other,
                    };
                    let provider = report["provider"].as_str().unwrap_or("OMP");
                    let id = limit["id"].as_str().unwrap_or("usage");
                    let mut m = metric(
                        &format!("{provider}-{i}-{id}-{j}"),
                        &format!("{provider} · {label}"),
                        kind,
                        unit,
                        period,
                        "OMP account",
                    );
                    for key in ["used", "remaining", "limit"] {
                        put_number(&mut m, key, &amount[key]);
                    }
                    if m.get("used").is_none()
                        && let Some(fraction) = finite(&amount["usedFraction"])
                    {
                        m["used"] = json!(fraction * 100.0);
                        m["limit"] = json!(100);
                        m["unit"] = json!("%");
                    }
                    put_number(&mut m, "resetsAt", &limit["window"]["resetsAt"]);
                    metrics.push(m);
                }
            }
        }
    }
    json!({"version":1,"metrics":metrics,"note":"OMP provider/account scope; no data may mean the active OMP profile has no usage-capable login."})
}
fn add_claude_tokens(snapshot: &mut Value, stats: &Value) {
    let Some(models) = stats["modelUsage"].as_object() else {
        return;
    };
    let total: f64 = models
        .values()
        .flat_map(|m| {
            [
                "inputTokens",
                "outputTokens",
                "cacheReadInputTokens",
                "cacheCreationInputTokens",
            ]
            .map(|key| finite(&m[key]).unwrap_or(0.0))
        })
        .sum();
    let as_of = stats["lastComputedDate"].as_str().unwrap_or("unknown date");
    let mut m = metric(
        "local-tokens",
        &format!("Cached tokens · {as_of}"),
        "tokens",
        "tokens",
        "cached total",
        &format!("local CLI · as of {as_of}"),
    );
    m["used"] = json!(total);
    snapshot["metrics"].as_array_mut().unwrap().push(m);
    snapshot["note"] = json!(format!(
        "Observed tokens count new local CLI activity while widgetsack runs, including cache reads/writes. Cached total computed {as_of}. Neither is your account token allowance."
    ));
}
#[tauri::command]
pub async fn read_ai_usage(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request: UsageRequest,
) -> Result<Value, String> {
    if !request.command.trim().is_empty() || request.source == "command" {
        crate::layout_grants::authorize_saved(&app, window.label(), "usage command", |g| {
            g.allows_command(&request.command)
        })
        .await?;
    } else {
        crate::layout_grants::authorize_saved(&app, window.label(), "usage source", |g| {
            g.allows_usage_source(&request.source, &request.env, &request.account)
        })
        .await?;
    }
    static CACHE: OnceLock<UsageCache> = OnceLock::new();
    let key = format!(
        "{}\0{}\0{}\0{}",
        request.source, request.command, request.env, request.account
    );
    let entry = {
        let mut cache = CACHE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .await;
        cache
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    };
    let mut cached = entry.lock().await;
    if let Some((at, cache_for, result)) = &*cached
        && at.elapsed() < *cache_for
    {
        return result.clone();
    }
    let result = tokio::time::timeout(
        Duration::from_secs(request.timeout.clamp(5, 60)),
        fetch(&request),
    )
    .await
    .map_err(|_| UsageError::from("Usage refresh timed out"))
    .and_then(|v| v);
    let cache_for = result
        .as_ref()
        .err()
        .map_or(Duration::from_secs(60), |e| e.cache_for);
    let result = result.map_err(|e| e.message);
    if let Ok(snapshot) = &result {
        crate::log::info("ai-usage", "usage refreshed")
            .field("provider", &request.source)
            .field(
                "readings",
                snapshot["metrics"].as_array().map_or(0, Vec::len),
            )
            .emit();
    }
    *cached = Some((Instant::now(), cache_for, result.clone()));
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rate_limits_wait_at_least_fifteen_minutes_and_respect_longer_retry_after() {
        for value in [None, Some("bad"), Some("0"), Some("60")] {
            assert_eq!(rate_limit_delay(value), Duration::from_secs(900));
        }
        assert_eq!(rate_limit_delay(Some(" 1800 ")), Duration::from_secs(1800));
        assert_eq!(
            UsageError::from("offline").cache_for,
            Duration::from_secs(60)
        );
    }
    #[tokio::test]
    #[ignore = "queries signed-in local CLI accounts and provider usage endpoints; run explicitly"]
    async fn live_usage_read_smoke() {
        for source in ["codex", "claude"] {
            let request = UsageRequest {
                source: source.into(),
                command: String::new(),
                env: default_env(),
                account: String::new(),
                timeout: 30,
            };
            let value = tokio::time::timeout(Duration::from_secs(30), fetch(&request))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(value["version"], 1);
            assert!(!value["metrics"].as_array().unwrap().is_empty());
            println!(
                "{source}: {} usage readings",
                value["metrics"].as_array().unwrap().len()
            );
        }
    }
    #[test]
    fn cached_claude_tokens_carry_their_date_and_local_scope() {
        let mut snapshot = claude_snapshot(&json!({}));
        add_claude_tokens(
            &mut snapshot,
            &json!({"lastComputedDate":"2026-05-08","modelUsage":{"m":{"inputTokens":10,"outputTokens":20,"cacheReadInputTokens":30,"cacheCreationInputTokens":40}}}),
        );
        assert_eq!(snapshot["metrics"][0]["used"], 100.0);
        assert!(
            snapshot["metrics"][0]["scope"]
                .as_str()
                .unwrap()
                .contains("2026-05-08")
        );
    }
    #[test]
    fn codex_uses_actual_window_duration_and_preserves_zero_bank() {
        let data = codex_snapshot(
            &json!({"rateLimits":{"primary":{"usedPercent":98,"windowDurationMins":10080,"resetsAt":123}},"rateLimitResetCredits":{"availableCount":0,"credits":[]}}),
            &json!({"summary":{"lifetimeTokens":42}}),
        );
        assert_eq!(data["metrics"][0]["period"], "week");
        assert_eq!(data["metrics"][0]["resetsAt"], 123000.0);
        assert_eq!(data["metrics"].as_array().unwrap().len(), 2);
        assert_eq!(data["bankedResets"]["available"], 0);
        assert!(
            codex_snapshot(&json!({}), &json!({}))
                .get("bankedResets")
                .is_none()
        );
    }
    #[test]
    fn claude_missing_window_is_not_zero_and_credits_are_dollars() {
        let data = claude_snapshot(
            &json!({"seven_day":{"utilization":100,"resets_at":"2026-10-21T01:00:00Z"},"extra_usage":{"is_enabled":true,"used_credits":250,"monthly_limit":1000}}),
        );
        assert_eq!(data["metrics"].as_array().unwrap().len(), 2);
        assert_eq!(data["metrics"][1]["used"], 2.5);
        assert!(data.get("bankedResets").is_none());
    }
    #[test]
    fn router_keeps_key_allowance_separate_from_account_balance() {
        let data = openrouter_snapshot(
            &json!({"data":{"usage":5,"limit":null,"usage_daily":2}}),
            Some(&json!({"data":{"total_credits":20,"total_usage":7}})),
        );
        assert!(data["metrics"][0].get("limit").is_none());
        assert_eq!(data["metrics"][2]["remaining"], 13.0);
        assert_eq!(data["metrics"][0]["scope"], "API key");
        assert_eq!(data["metrics"][2]["scope"], "account");
    }
    #[test]
    fn omp_handles_empty_and_uncapped_reports() {
        assert_eq!(omp_snapshot(&json!({"reports":[]}))["metrics"], json!([]));
        let data = omp_snapshot(
            &json!({"reports":[{"limits":[{"label":"Tokens","amount":{"used":42,"unit":"tokens"}}]}]}),
        );
        assert_eq!(data["metrics"][0]["used"], 42.0);
        assert!(data["metrics"][0].get("limit").is_none());
    }
}
