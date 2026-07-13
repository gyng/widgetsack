//! The AI provider abstraction — a server-side LLM proxy, PEER to ha.rs / mqtt.rs / stocks.rs.
//! One config (`plugins/llm.json`) holds the provider choice + endpoint + (secret) API key; the key
//! lives server-side ONLY and never crosses the bridge (mirrors the HA token rule). All outbound HTTP
//! is done here in reqwest — the webview CSP (`connect-src 'self' ipc:`) blocks a direct fetch to an
//! LLM host, so the frontend `invoke`s these commands instead.
//!
//! Three providers behind one shape, selected by `provider`:
//!   - `anthropic`: POST `/v1/messages`, `x-api-key` + `anthropic-version` headers, `system` is a top-level field, text in `content[].text`.
//!   - `openai`: POST `/chat/completions`, `Authorization: Bearer`, text in `choices[0].message.content`. Covers any OpenAI-compatible endpoint (Groq, OpenRouter, LM Studio, llama.cpp, Ollama's `/v1`) via a custom `base_url`.
//!   - `ollama`: POST `/api/chat`, keyless (local), text in `message.content`.
//!
//! Outer-ring adapter like its peers: the per-provider request/response/stream logic lives in pure
//! seams (`chat_endpoint`, `build_chat_body`, `parse_chat_text`, `parse_models`, `stream_event_from_line`,
//! `provider_error`) that are unit-tested without a socket. Two surfaces:
//!   - request/response: `llm_complete` (the workhorse — used by the layout assistant + briefing),
//!     `llm_test_connection`, `llm_list_models`.
//!   - streaming: `llm_stream` spawns a task that emits `llm_delta` events token-by-token; `llm_cancel`
//!     aborts an in-flight stream by id. Handles are tracked in the managed `LlmState`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::async_runtime::{JoinHandle, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::log;

/// Streamed tokens ride their OWN event (not `telemetry`) because a chat transcript is a growing
/// whole-value, not a per-id sensor sample. The frontend `lib/llm/source.ts` listens here.
use crate::bridge::LLM_DELTA_EVENT;

fn default_provider() -> String {
    "openai".to_string()
}
fn default_temperature() -> f64 {
    0.7
}
fn default_max_tokens() -> u32 {
    1024
}

/// Server-side AI provider config (`plugins/llm.json`). The `api_key` is the secret — it is written
/// here and NEVER serialized back to the webview (see `LlmStatus`). `#[serde(default)]` everywhere so
/// a partial / older file still parses (AGENTS.md forward-compat rule).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LlmConfig {
    #[serde(default = "default_provider")]
    pub provider: String,
    /// Empty means "use the provider's default base URL" (see `default_base_url`). Set this to point
    /// at a self-hosted / compatible endpoint (e.g. `http://localhost:11434` for Ollama).
    #[serde(default)]
    pub base_url: String,
    /// The secret. Stays in this struct + on disk only.
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    /// Accept self-signed / invalid TLS (a local endpoint behind a self-signed cert). Mirrors the HA
    /// opt-in: drops BOTH cert and hostname checks.
    #[serde(default)]
    pub insecure: bool,
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    /// Opt-in: run the local agent-control server (media/HA actuation over a localhost port). OFF by
    /// default — this opens a token-guarded 127.0.0.1 endpoint (see control.rs).
    #[serde(default)]
    pub agent_control: bool,
    /// Speech-to-text model (whisper-style); blank → the provider default (`whisper-1`).
    #[serde(default)]
    pub stt_model: String,
    /// Text-to-speech model (OpenAI-style `/audio/speech`); blank → the provider default (`tts-1`).
    #[serde(default)]
    pub tts_model: String,
    /// Text-to-speech voice (e.g. `alloy`); blank → the provider default.
    #[serde(default)]
    pub tts_voice: String,
}

/// One provider's stored settings inside the multi-provider config file. The provider id is the MAP
/// KEY in `LlmFile.providers`, so it isn't repeated here. Every field defaults so a partial / older
/// entry still parses. The `api_key` is the secret — written here, never serialized back to the webview.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct StoredProvider {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub insecure: bool,
    #[serde(default)]
    pub stt_model: String,
    #[serde(default)]
    pub tts_model: String,
    #[serde(default)]
    pub tts_voice: String,
}

/// The on-disk `plugins/llm.json` root (multi-provider): per-provider credentials/settings keyed by
/// provider id, an `active` selection, and the GLOBAL generation params (temperature / max tokens) +
/// the agent-control toggle. Authenticating several providers means each keeps its own entry, so
/// switching `active` never discards another's key. Legacy flat files migrate on load (`migrate_flat`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LlmFile {
    #[serde(default = "default_provider")]
    pub active: String,
    #[serde(default)]
    pub providers: HashMap<String, StoredProvider>,
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub agent_control: bool,
}

impl LlmFile {
    fn empty() -> Self {
        LlmFile {
            active: default_provider(),
            providers: HashMap::new(),
            temperature: default_temperature(),
            max_tokens: default_max_tokens(),
            agent_control: false,
        }
    }

    /// Resolve one provider's stored entry (or empty defaults) + the global params into the flat
    /// request config the HTTP seams consume.
    fn resolve(&self, provider: &str) -> LlmConfig {
        let p = self.providers.get(provider).cloned().unwrap_or_default();
        LlmConfig {
            provider: provider.to_string(),
            base_url: p.base_url,
            api_key: p.api_key,
            model: p.model,
            insecure: p.insecure,
            temperature: self.temperature,
            max_tokens: self.max_tokens,
            agent_control: self.agent_control,
            stt_model: p.stt_model,
            tts_model: p.tts_model,
            tts_voice: p.tts_voice,
        }
    }

    fn resolve_active(&self) -> LlmConfig {
        self.resolve(&self.active)
    }
}

/// Convert a legacy flat config (pre-multi-provider `plugins/llm.json`) into the providers-map shape:
/// its single provider becomes the one entry and the active selection. Pure — unit-tested.
fn migrate_flat(old: LlmConfig) -> LlmFile {
    let mut providers = HashMap::new();
    providers.insert(
        old.provider.clone(),
        StoredProvider {
            base_url: old.base_url,
            api_key: old.api_key,
            model: old.model,
            insecure: old.insecure,
            stt_model: old.stt_model,
            tts_model: old.tts_model,
            tts_voice: old.tts_voice,
        },
    );
    LlmFile {
        active: old.provider,
        providers,
        temperature: old.temperature,
        max_tokens: old.max_tokens,
        agent_control: old.agent_control,
    }
}

/// Parse the on-disk JSON, accepting BOTH the new providers-map shape and the legacy flat shape (a file
/// with no `providers` key). Keeps old configs working without a manual migration. Pure — unit-tested.
fn parse_config_json(txt: &str) -> Result<LlmFile, String> {
    let v: Value = serde_json::from_str(txt).map_err(|e| e.to_string())?;
    if v.get("providers").is_some() {
        serde_json::from_value(v).map_err(|e| e.to_string())
    } else {
        let old: LlmConfig = serde_json::from_value(v).map_err(|e| e.to_string())?;
        Ok(migrate_flat(old))
    }
}

/// One provider's NON-SECRET status — everything the webview may learn EXCEPT the key (only `has_key`).
/// camelCase on the wire (matches `ProviderStatus` in `llm-types.ts`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    /// The EFFECTIVE base url (the provider default when none is set), so the UI can show it.
    pub base_url: String,
    pub model: String,
    /// Whether a key is on file — the only thing the UI learns about the secret.
    pub has_key: bool,
    pub insecure: bool,
    pub stt_model: String,
    pub tts_model: String,
    pub tts_voice: String,
}

/// What the webview is allowed to learn — every configured provider's non-secret status (so the UI can
/// switch the active provider without losing the others' settings), the active selection, and the
/// global generation params. Deliberately WITHOUT any api_key. camelCase on the wire (`llm-types.ts`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmStatus {
    /// Usable: the ACTIVE provider is keyless (ollama) or has a saved key.
    pub configured: bool,
    /// The active provider id.
    pub active: String,
    /// Per-provider non-secret status, keyed by provider id (only the configured ones).
    pub providers: HashMap<String, ProviderStatus>,
    pub temperature: f64,
    pub max_tokens: u32,
    /// Whether the opt-in agent-control server is enabled (global).
    pub agent_control: bool,
}

/// Result of a successful `llm_test_connection` — the model that answered + a short echo of its reply.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmTestResult {
    pub model: String,
    pub reply: String,
}

/// One selectable model from `llm_list_models`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmModel {
    pub id: String,
    pub label: String,
}

/// One chat turn the webview sends in. `role` ∈ {system,user,assistant}; the provider mapping
/// (e.g. anthropic lifts `system` out of the list) happens in `build_chat_body`.
#[derive(Clone, Debug, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// One streamed delta emitted over `llm_delta`. camelCase on the wire (mirrors `LlmDelta` in
/// `core/llm.ts`). `done` marks the final frame; `error` is set instead of `token` on failure.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmDelta {
    request_id: String,
    token: String,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Managed state: in-flight stream tasks keyed by their request id, so `llm_cancel` can abort one.
/// Each entry pairs the handle with a monotonic generation so a completing task only reclaims its OWN
/// slot (not one a same-id restart just inserted). `gen` hands out those generations.
#[derive(Default)]
pub struct LlmState {
    streams: Mutex<HashMap<String, (u64, JoinHandle<()>)>>,
    next_gen: AtomicU64,
}

// ---- config I/O (server-side; api_key never leaves) ----

fn llm_config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("plugins").join("llm.json"))
}

/// Read the multi-provider `plugins/llm.json` (migrating a legacy flat file), or `None` if it doesn't
/// exist.
pub fn load_llm_file<R: Runtime>(app: &AppHandle<R>) -> Result<Option<LlmFile>, String> {
    let path = llm_config_path(app)?;
    crate::secure_config::read(&path)?
        .map(|txt| parse_config_json(&txt))
        .transpose()
}

/// The resolved ACTIVE provider config (the flat request config the HTTP seams consume), or `None`
/// when nothing is saved. Peers (control.rs) read `.agent_control` from this.
pub fn load_llm_config<R: Runtime>(app: &AppHandle<R>) -> Result<Option<LlmConfig>, String> {
    Ok(load_llm_file(app)?.map(|f| f.resolve_active()))
}

// ---- pure seams (unit-tested, no I/O) ----

/// Whether the provider needs an API key. Ollama is local/keyless; everything else is keyed.
fn needs_key(provider: &str) -> bool {
    !matches!(provider, "ollama")
}

/// The default base URL for a provider (used when the config leaves `base_url` blank).
fn default_base_url(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "https://api.anthropic.com",
        "ollama" => "http://localhost:11434",
        // openai + any OpenAI-compatible default
        _ => "https://api.openai.com/v1",
    }
}

/// The effective base URL for a provider (override, else the provider default), trailing slash stripped.
fn effective_base_of(provider: &str, base_url: &str) -> String {
    let b = base_url.trim().trim_end_matches('/');
    if b.is_empty() {
        default_base_url(provider).to_string()
    } else {
        b.to_string()
    }
}

/// The effective base URL of a resolved config.
fn effective_base(cfg: &LlmConfig) -> String {
    effective_base_of(&cfg.provider, &cfg.base_url)
}

/// The chat-completion endpoint for a provider given its (already-normalized) base URL.
fn chat_endpoint(provider: &str, base: &str) -> String {
    match provider {
        "anthropic" => format!("{base}/v1/messages"),
        "ollama" => format!("{base}/api/chat"),
        _ => format!("{base}/chat/completions"),
    }
}

/// The model-list endpoint (GET) for a provider.
fn models_endpoint(provider: &str, base: &str) -> String {
    match provider {
        "anthropic" => format!("{base}/v1/models"),
        "ollama" => format!("{base}/api/tags"),
        _ => format!("{base}/models"),
    }
}

/// The OpenAI-style speech-to-text endpoint (whisper). anthropic + ollama have none.
fn transcribe_endpoint(base: &str) -> String {
    format!("{base}/audio/transcriptions")
}

/// Whether the provider exposes an OpenAI-style transcription endpoint. anthropic + ollama do not.
fn supports_transcription(provider: &str) -> bool {
    !matches!(provider, "anthropic" | "ollama")
}

/// A file extension for the recorded audio's mime type (the API infers the format from the filename).
fn mime_ext(mime: &str) -> &'static str {
    if mime.contains("webm") {
        "webm"
    } else if mime.contains("ogg") {
        "ogg"
    } else if mime.contains("wav") {
        "wav"
    } else if mime.contains("mp4") || mime.contains("m4a") || mime.contains("mpeg") {
        "m4a"
    } else {
        "webm"
    }
}

/// Pull the transcript text out of a transcription response (`{ "text": "..." }`).
fn parse_transcription(v: &Value) -> Option<String> {
    v["text"]
        .as_str()
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

/// The OpenAI-style text-to-speech endpoint. Shares `supports_transcription`'s provider gate (the same
/// OpenAI-compatible providers expose `/audio/speech`); anthropic + ollama have none.
fn tts_endpoint(base: &str) -> String {
    format!("{base}/audio/speech")
}

/// Whether the provider exposes an OpenAI-style text-to-speech endpoint (same set as transcription).
fn supports_tts(provider: &str) -> bool {
    supports_transcription(provider)
}

/// Sensible default TTS model / voice when the user hasn't picked one (OpenAI's defaults).
fn default_tts_model() -> &'static str {
    "tts-1"
}
fn default_tts_voice() -> &'static str {
    "alloy"
}

/// Build the JSON body for an OpenAI-style `/audio/speech` request. `response_format` mp3 so the
/// webview can play the bytes via an <audio> element. Pure — unit-tested.
fn build_tts_body(model: &str, voice: &str, text: &str) -> Value {
    json!({ "model": model, "voice": voice, "input": text, "response_format": "mp3" })
}

/// Synthesized audio handed back to the webview: raw bytes + their mime type (so the frontend can build
/// a Blob and play it). camelCase on the wire (mirrors `LlmAudio` in `llm-types.ts`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmAudio {
    pub audio: Vec<u8>,
    pub mime: String,
}

/// A reasonable default model name per provider when the user hasn't picked one (a starting point — the
/// user configures the real one). Names drift, so this is best-effort, not authoritative.
fn default_model(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "claude-sonnet-4-5",
        "ollama" => "llama3.2",
        _ => "gpt-4o-mini",
    }
}

fn model_or_default(cfg: &LlmConfig) -> String {
    if cfg.model.trim().is_empty() {
        default_model(&cfg.provider).to_string()
    } else {
        cfg.model.trim().to_string()
    }
}

/// Map the incoming messages to a provider's wire array. For anthropic, system turns are EXCLUDED
/// (they are lifted into the top-level `system` field by `build_chat_body`) and any non-`assistant`
/// role is coerced to `user` (anthropic only accepts user/assistant in the list).
fn messages_json(provider: &str, messages: &[ChatMessage]) -> Vec<Value> {
    messages
        .iter()
        .filter(|m| !(provider == "anthropic" && m.role == "system"))
        .map(|m| {
            let role = if provider == "anthropic" && m.role != "assistant" {
                "user"
            } else {
                m.role.as_str()
            };
            json!({ "role": role, "content": m.content })
        })
        .collect()
}

/// Concatenate all `system`-role messages (anthropic carries the system prompt out-of-band).
fn system_text(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Build the JSON request body for a chat completion, per provider.
fn build_chat_body(
    provider: &str,
    model: &str,
    messages: &[ChatMessage],
    temperature: f64,
    max_tokens: u32,
    stream: bool,
) -> Value {
    match provider {
        "anthropic" => {
            let mut body = json!({
                "model": model,
                "max_tokens": max_tokens,
                // Anthropic caps temperature at 1.0 (the UI allows up to 2 for OpenAI) — clamp so an
                // Anthropic user who raised it past 1 doesn't get a hard 400 on every request.
                "temperature": temperature.min(1.0),
                "stream": stream,
                "messages": messages_json(provider, messages),
            });
            let sys = system_text(messages);
            if !sys.is_empty() {
                body["system"] = json!(sys);
            }
            body
        }
        "ollama" => json!({
            "model": model,
            "messages": messages_json(provider, messages),
            "stream": stream,
            "options": { "temperature": temperature, "num_predict": max_tokens },
        }),
        _ => {
            let mut body = json!({
                "model": model,
                "messages": messages_json(provider, messages),
                "stream": stream,
            });
            if uses_completion_tokens(model) {
                // Next-gen / reasoning OpenAI models (gpt-5*, o-series) REJECT the legacy `max_tokens`
                // ("use max_completion_tokens instead") and also reject a non-default `temperature`, so
                // send the new field and omit temperature — otherwise every request 400s.
                body["max_completion_tokens"] = json!(max_tokens);
            } else {
                body["temperature"] = json!(temperature);
                body["max_tokens"] = json!(max_tokens);
            }
            body
        }
    }
}

/// Whether an OpenAI-style model needs `max_completion_tokens` (and no custom temperature) instead of
/// the legacy `max_tokens`. True for the reasoning o-series (o1/o3/o4…) and the gpt-5 family; older
/// models (gpt-4o…) and most OpenAI-compatible servers still take `max_tokens`.
fn uses_completion_tokens(model: &str) -> bool {
    let m = model.trim();
    m.starts_with("gpt-5") || m.starts_with("o1") || m.starts_with("o3") || m.starts_with("o4")
}

/// Extract the assistant's reply text from a non-streamed response body, per provider.
fn parse_chat_text(provider: &str, v: &Value) -> Option<String> {
    let text = match provider {
        "anthropic" => v["content"]
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default(),
        "ollama" => v["message"]["content"].as_str().unwrap_or("").to_string(),
        _ => v["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string(),
    };
    if text.is_empty() { None } else { Some(text) }
}

/// Pull a human-readable error message out of an error response body (best-effort).
fn provider_error(v: &Value) -> Option<String> {
    v["error"]["message"]
        .as_str()
        .or_else(|| v["error"].as_str())
        .or_else(|| v["message"].as_str())
        .map(String::from)
}

/// Map a model-list response body to selectable models, per provider.
fn parse_models(provider: &str, v: &Value) -> Vec<LlmModel> {
    let ids: Vec<String> = match provider {
        "ollama" => v["models"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| m["name"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        // anthropic + openai both use `data: [{ id }]`
        _ => v["data"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| m["id"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
    };
    ids.into_iter()
        .map(|id| LlmModel {
            label: id.clone(),
            id,
        })
        .collect()
}

/// What a single line of a streamed response means.
#[derive(Debug, PartialEq)]
enum StreamEvent {
    Token(String),
    Done,
    Ignore,
}

/// Parse ONE line of a streamed body into a `StreamEvent`. SSE providers (anthropic/openai) prefix
/// payloads with `data: `; ollama emits a raw JSON object per line. Pure — the task owns the buffering.
fn stream_event_from_line(provider: &str, line: &str) -> StreamEvent {
    let line = line.trim();
    if line.is_empty() {
        return StreamEvent::Ignore;
    }
    if provider == "ollama" {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return StreamEvent::Ignore;
        };
        if v["done"].as_bool() == Some(true) {
            return StreamEvent::Done;
        }
        return match v["message"]["content"].as_str() {
            Some(t) if !t.is_empty() => StreamEvent::Token(t.to_string()),
            _ => StreamEvent::Ignore,
        };
    }
    // SSE
    let Some(rest) = line.strip_prefix("data:") else {
        return StreamEvent::Ignore; // `event:` / comment lines
    };
    let rest = rest.trim();
    if rest == "[DONE]" {
        return StreamEvent::Done;
    }
    let Ok(v) = serde_json::from_str::<Value>(rest) else {
        return StreamEvent::Ignore;
    };
    if provider == "anthropic" {
        match v["type"].as_str() {
            Some("message_stop") => StreamEvent::Done,
            Some("content_block_delta") => match v["delta"]["text"].as_str() {
                Some(t) => StreamEvent::Token(t.to_string()),
                None => StreamEvent::Ignore,
            },
            _ => StreamEvent::Ignore,
        }
    } else {
        match v["choices"][0]["delta"]["content"].as_str() {
            Some(t) if !t.is_empty() => StreamEvent::Token(t.to_string()),
            _ => StreamEvent::Ignore,
        }
    }
}

// ---- HTTP ----

/// A reqwest client honouring the `insecure` opt-in (mirrors ha_http_client). 120s timeout — LLM
/// responses can be slow.
fn llm_http_client(insecure: bool) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(120));
    if insecure {
        builder = builder
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true);
    }
    builder.build().map_err(|e| e.to_string())
}

/// Attach the provider's auth headers to a request. The key never leaves this process.
fn apply_auth(
    rb: reqwest::RequestBuilder,
    provider: &str,
    api_key: &str,
) -> reqwest::RequestBuilder {
    match provider {
        "anthropic" => rb
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        "ollama" => rb, // keyless
        _ => rb.bearer_auth(api_key),
    }
}

/// A non-streamed chat completion. Loads nothing — the caller passes a resolved config.
async fn chat_once(cfg: &LlmConfig, messages: &[ChatMessage]) -> Result<String, String> {
    if needs_key(&cfg.provider) && cfg.api_key.trim().is_empty() {
        return Err("no API key configured — set one in the AI Provider settings".into());
    }
    let base = effective_base(cfg);
    let url = chat_endpoint(&cfg.provider, &base);
    let body = build_chat_body(
        &cfg.provider,
        &model_or_default(cfg),
        messages,
        cfg.temperature,
        cfg.max_tokens,
        false,
    );
    let client = llm_http_client(cfg.insecure)?;
    let resp = apply_auth(client.post(&url), &cfg.provider, &cfg.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    // Read the body as text first so a NON-JSON error (a proxy 502, an HTML block page, a wrong base
    // URL) surfaces the HTTP status instead of a confusing serde "expected value" error. Mirrors the
    // streaming path's error handling.
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| provider_error(&v))
            .unwrap_or_else(|| format!("LLM request failed: HTTP {status}"));
        return Err(msg);
    }
    let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    parse_chat_text(&cfg.provider, &v).ok_or_else(|| "the model returned no text".into())
}

/// Resolve the api_key for an ad-hoc (UNSAVED) request to `provider`: a blank incoming key means "use
/// that provider's saved one" (the UI holds the key write-only, so testing a changed URL must reuse the
/// stored secret).
fn resolve_key<R: Runtime>(
    app: &AppHandle<R>,
    provider: &str,
    incoming: String,
) -> Result<String, String> {
    if !incoming.is_empty() {
        return Ok(incoming);
    }
    Ok(load_llm_file(app)?
        .and_then(|f| f.providers.get(provider).map(|p| p.api_key.clone()))
        .unwrap_or_default())
}

// ---- Tauri commands ----

/// Persist one provider's entry in `plugins/llm.json` and make it the ACTIVE provider (creates
/// `plugins/`). The api_key is written server-side only; a blank `api_key` keeps that provider's
/// previously-saved one (write-only UI). Other providers' entries are preserved untouched, so several
/// can stay authenticated at once. `temperature`/`max_tokens`/`agent_control` are global. Studio-only.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn save_llm_config(
    window: tauri::WebviewWindow,
    app: AppHandle,
    provider: String,
    base_url: Option<String>,
    api_key: String,
    model: Option<String>,
    insecure: Option<bool>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
    agent_control: Option<bool>,
    stt_model: Option<String>,
    tts_model: Option<String>,
    tts_voice: Option<String>,
) -> Result<(), String> {
    if window.label() != "studio" {
        return Err("save_llm_config is only allowed from the studio window".into());
    }
    let path = llm_config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let id = if provider.is_empty() {
        default_provider()
    } else {
        provider
    };
    let mut file = load_llm_file(&app)?.unwrap_or_else(LlmFile::empty);
    // Merge into THIS provider's entry — leave the others (and their keys) alone.
    let mut entry = file.providers.get(&id).cloned().unwrap_or_default();
    if !api_key.is_empty() {
        entry.api_key = api_key; // blank keeps the saved one
    }
    if let Some(b) = base_url {
        entry.base_url = b;
    }
    if let Some(m) = model {
        entry.model = m;
    }
    if let Some(i) = insecure {
        entry.insecure = i;
    }
    if let Some(s) = stt_model {
        entry.stt_model = s;
    }
    if let Some(t) = tts_model {
        entry.tts_model = t;
    }
    if let Some(v) = tts_voice {
        entry.tts_voice = v;
    }
    file.providers.insert(id.clone(), entry);
    file.active = id;
    if let Some(t) = temperature {
        file.temperature = t;
    }
    if let Some(m) = max_tokens {
        file.max_tokens = m;
    }
    if let Some(a) = agent_control {
        file.agent_control = a;
    }
    let txt = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    crate::secure_config::write(&path, &txt)
}

/// The (non-secret) config for EVERY configured provider + the active selection — never any api_key,
/// only per-provider `has_key`. The UI uses the map to switch the active provider without a round-trip.
#[tauri::command]
pub fn llm_config_status<R: Runtime>(app: AppHandle<R>) -> Result<LlmStatus, String> {
    let file = load_llm_file(&app)?.unwrap_or_else(LlmFile::empty);
    let providers = file
        .providers
        .iter()
        .map(|(id, p)| {
            (
                id.clone(),
                ProviderStatus {
                    base_url: effective_base_of(id, &p.base_url),
                    model: p.model.clone(),
                    has_key: !p.api_key.trim().is_empty(),
                    insecure: p.insecure,
                    stt_model: p.stt_model.clone(),
                    tts_model: p.tts_model.clone(),
                    tts_voice: p.tts_voice.clone(),
                },
            )
        })
        .collect();
    let active_has_key = file
        .providers
        .get(&file.active)
        .map(|p| !p.api_key.trim().is_empty())
        .unwrap_or(false);
    Ok(LlmStatus {
        configured: !needs_key(&file.active) || active_has_key,
        active: file.active,
        providers,
        temperature: file.temperature,
        max_tokens: file.max_tokens,
        agent_control: file.agent_control,
    })
}

/// Validate an UNSAVED provider/url/key/model by sending a tiny prompt, so the settings UI can tell
/// "bad key" / "unreachable" / "wrong model" apart before persisting. Studio-only.
#[tauri::command]
pub async fn llm_test_connection(
    window: tauri::WebviewWindow,
    app: AppHandle,
    provider: String,
    base_url: Option<String>,
    api_key: String,
    model: Option<String>,
    insecure: Option<bool>,
) -> Result<LlmTestResult, String> {
    if window.label() != "studio" {
        return Err("llm_test_connection is only allowed from the studio window".into());
    }
    let id = if provider.is_empty() {
        default_provider()
    } else {
        provider
    };
    let cfg = LlmConfig {
        api_key: resolve_key(&app, &id, api_key)?,
        provider: id,
        base_url: base_url.unwrap_or_default(),
        model: model.unwrap_or_default(),
        insecure: insecure.unwrap_or(false),
        temperature: 0.0,
        max_tokens: 32,
        agent_control: false,
        stt_model: String::new(),
        tts_model: String::new(),
        tts_voice: String::new(),
    };
    let messages = vec![ChatMessage {
        role: "user".into(),
        content: "Reply with the single word: OK".into(),
    }];
    let reply = chat_once(&cfg, &messages).await?;
    Ok(LlmTestResult {
        model: model_or_default(&cfg),
        reply: reply.trim().chars().take(120).collect(),
    })
}

/// One-shot completion — the workhorse used across the app (layout assistant, briefing). Loads the
/// saved config, runs the messages, returns the assistant's text. NOT studio-guarded: any window may
/// ask (the overlay's briefing widget runs here too); the key never crosses the bridge regardless.
#[tauri::command]
pub async fn llm_complete<R: Runtime>(
    app: AppHandle<R>,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> Result<String, String> {
    let mut cfg = load_llm_config(&app)?.ok_or("AI provider not configured")?;
    if let Some(t) = temperature {
        cfg.temperature = t;
    }
    if let Some(m) = max_tokens {
        cfg.max_tokens = m;
    }
    chat_once(&cfg, &messages).await
}

/// The available models for the settings model picker. Best-effort: an empty list when the provider
/// has no catalog endpoint, an error string when the call fails. Accepts the settings form's
/// (possibly UNSAVED) provider / url / key / insecure so the picker can refresh BEFORE Save — mirrors
/// `llm_test_connection`. With no provider it falls back to the saved active config; a blank key
/// resolves to that provider's saved one (the UI holds the key write-only).
#[tauri::command]
pub async fn llm_list_models<R: Runtime>(
    app: AppHandle<R>,
    provider: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    insecure: Option<bool>,
) -> Result<Vec<LlmModel>, String> {
    let (provider, base, key, insecure) = match provider.filter(|p| !p.is_empty()) {
        Some(p) => {
            let key = resolve_key(&app, &p, api_key.unwrap_or_default())?;
            let base = effective_base_of(&p, &base_url.unwrap_or_default());
            (p, base, key, insecure.unwrap_or(false))
        }
        None => {
            let cfg = load_llm_config(&app)?.ok_or("AI provider not configured")?;
            (
                cfg.provider.clone(),
                effective_base(&cfg),
                cfg.api_key,
                cfg.insecure,
            )
        }
    };
    let url = models_endpoint(&provider, &base);
    let client = llm_http_client(insecure)?;
    let resp = apply_auth(client.get(&url), &provider, &key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("could not list models: HTTP {}", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parse_models(&provider, &v))
}

/// Transcribe recorded audio (speech-to-text). The webview captures the mic (getUserMedia/MediaRecorder)
/// and hands the raw bytes here; this uploads them to the provider's OpenAI-style transcription endpoint
/// (key server-side) and returns the text. Only OpenAI-compatible providers expose this — anthropic and
/// ollama do not.
#[tauri::command]
pub async fn llm_transcribe<R: Runtime>(
    app: AppHandle<R>,
    audio: Vec<u8>,
    mime: Option<String>,
    model: Option<String>,
    language: Option<String>,
) -> Result<String, String> {
    let cfg = load_llm_config(&app)?.ok_or("AI provider not configured")?;
    if !supports_transcription(&cfg.provider) {
        return Err(format!(
            "the '{}' provider has no speech-to-text endpoint — use an OpenAI-compatible provider",
            cfg.provider
        ));
    }
    if needs_key(&cfg.provider) && cfg.api_key.trim().is_empty() {
        return Err("no API key configured".into());
    }
    if audio.is_empty() {
        return Err("no audio captured".into());
    }
    let base = effective_base(&cfg);
    let url = transcribe_endpoint(&base);
    // Resolve the model: an explicit arg wins, else the provider's saved stt_model, else whisper-1.
    // Trim + treat empty as unset, so a blank model never reaches the API.
    let nonempty = |s: &str| {
        let t = s.trim();
        (!t.is_empty()).then(|| t.to_string())
    };
    let model = model
        .and_then(|m| nonempty(&m))
        .or_else(|| nonempty(&cfg.stt_model))
        .unwrap_or_else(|| "whisper-1".to_string());
    let mime = mime.unwrap_or_else(|| "audio/webm".to_string());
    let part = reqwest::multipart::Part::bytes(audio)
        .file_name(format!("audio.{}", mime_ext(&mime)))
        .mime_str(&mime)
        .map_err(|e| e.to_string())?;
    let mut form = reqwest::multipart::Form::new()
        .text("model", model)
        .part("file", part);
    // An explicit spoken-language hint (ISO code) improves accuracy; "auto"/blank = let Whisper detect.
    if let Some(lang) = language {
        let lang = lang.trim();
        if !lang.is_empty() && !lang.eq_ignore_ascii_case("auto") {
            form = form.text("language", lang.to_string());
        }
    }
    let client = llm_http_client(cfg.insecure)?;
    let resp = apply_auth(client.post(&url), &cfg.provider, &cfg.api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| provider_error(&v))
            .unwrap_or_else(|| format!("transcription failed: HTTP {status}")));
    }
    let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    parse_transcription(&v).ok_or_else(|| "no transcription text in response".into())
}

/// Synthesize speech (text-to-speech) for `text` via the ACTIVE provider's OpenAI-style `/audio/speech`
/// endpoint, returning the raw audio bytes + mime so the webview can play them. The model/voice come
/// from the provider's saved config (defaults `tts-1` / `alloy`). Only OpenAI-compatible providers
/// expose this — anthropic + ollama do not (the frontend falls back to the browser's Web Speech voice).
/// NOT studio-guarded: the overlay's widgets read it aloud too; the key never crosses the bridge.
#[tauri::command]
pub async fn llm_synthesize<R: Runtime>(
    app: AppHandle<R>,
    text: String,
) -> Result<LlmAudio, String> {
    let cfg = load_llm_config(&app)?.ok_or("AI provider not configured")?;
    if !supports_tts(&cfg.provider) {
        return Err(format!(
            "the '{}' provider has no text-to-speech endpoint — use an OpenAI-compatible provider",
            cfg.provider
        ));
    }
    if needs_key(&cfg.provider) && cfg.api_key.trim().is_empty() {
        return Err("no API key configured".into());
    }
    let text = text.trim();
    if text.is_empty() {
        return Err("nothing to speak".into());
    }
    let model = if cfg.tts_model.trim().is_empty() {
        default_tts_model().to_string()
    } else {
        cfg.tts_model.trim().to_string()
    };
    let voice = if cfg.tts_voice.trim().is_empty() {
        default_tts_voice().to_string()
    } else {
        cfg.tts_voice.trim().to_string()
    };
    let base = effective_base(&cfg);
    let url = tts_endpoint(&base);
    let body = build_tts_body(&model, &voice, text);
    let client = llm_http_client(cfg.insecure)?;
    let resp = apply_auth(client.post(&url), &cfg.provider, &cfg.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        // The error body is JSON (audio is only returned on success), so surface the provider message.
        let body = resp.text().await.unwrap_or_default();
        return Err(serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| provider_error(&v))
            .unwrap_or_else(|| format!("speech synthesis failed: HTTP {status}")));
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/mpeg")
        .to_string();
    let audio = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
    if audio.is_empty() {
        return Err("speech synthesis returned no audio".into());
    }
    Ok(LlmAudio { audio, mime })
}

fn emit_delta<R: Runtime>(
    app: &AppHandle<R>,
    request_id: &str,
    token: &str,
    done: bool,
    error: Option<String>,
) {
    let _ = app.emit(
        LLM_DELTA_EVENT,
        &LlmDelta {
            request_id: request_id.to_string(),
            token: token.to_string(),
            done,
            error,
        },
    );
}

/// The streaming worker: open the streamed response and emit `llm_delta` frames token-by-token, then a
/// final `{ done: true }`. Errors emit a `{ done: true, error }` frame so the UI always terminates.
async fn run_stream<R: Runtime>(
    app: AppHandle<R>,
    request_id: String,
    cfg: LlmConfig,
    messages: Vec<ChatMessage>,
) {
    if needs_key(&cfg.provider) && cfg.api_key.trim().is_empty() {
        emit_delta(
            &app,
            &request_id,
            "",
            true,
            Some("no API key configured".into()),
        );
        return;
    }
    let base = effective_base(&cfg);
    let url = chat_endpoint(&cfg.provider, &base);
    let body = build_chat_body(
        &cfg.provider,
        &model_or_default(&cfg),
        &messages,
        cfg.temperature,
        cfg.max_tokens,
        true,
    );
    let client = match llm_http_client(cfg.insecure) {
        Ok(c) => c,
        Err(e) => return emit_delta(&app, &request_id, "", true, Some(e)),
    };
    let resp = match apply_auth(client.post(&url), &cfg.provider, &cfg.api_key)
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return emit_delta(&app, &request_id, "", true, Some(e.to_string())),
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let msg = resp
            .text()
            .await
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| provider_error(&v))
            .unwrap_or_else(|| format!("HTTP {status}"));
        return emit_delta(&app, &request_id, "", true, Some(msg));
    }

    // Buffer RAW bytes (not a String) and decode only COMPLETE lines: a multi-byte UTF-8 char split
    // across two network chunks would be mangled by a per-chunk lossy decode, but a full line is valid.
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    'outer: while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => return emit_delta(&app, &request_id, "", true, Some(e.to_string())),
        };
        buf.extend_from_slice(&bytes);
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            match stream_event_from_line(&cfg.provider, &line) {
                StreamEvent::Token(t) => emit_delta(&app, &request_id, &t, false, None),
                StreamEvent::Done => break 'outer,
                StreamEvent::Ignore => {}
            }
        }
    }
    // Flush any final buffered line (a stream that ends without a trailing newline).
    if !buf.is_empty() {
        let line = String::from_utf8_lossy(&buf);
        if let StreamEvent::Token(t) = stream_event_from_line(&cfg.provider, &line) {
            emit_delta(&app, &request_id, &t, false, None);
        }
    }
    emit_delta(&app, &request_id, "", true, None);
}

/// Start a streamed completion identified by `request_id`. Tokens arrive over the `llm_delta` event;
/// `llm_cancel(request_id)` aborts. A duplicate id aborts the previous stream first (idempotent start).
#[tauri::command]
pub async fn llm_stream<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LlmState>,
    request_id: String,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    let cfg = load_llm_config(&app)?.ok_or("AI provider not configured")?;
    let my_gen = state.next_gen.fetch_add(1, Ordering::Relaxed);
    let mut streams = state.streams.lock().await;
    if let Some((_, prev)) = streams.remove(&request_id) {
        prev.abort();
    }
    let app_for_task = app.clone();
    let id = request_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        run_stream(app_for_task.clone(), id.clone(), cfg, messages).await;
        // Reclaim our own slot on natural completion (an aborted task never reaches here), but only if a
        // same-id restart hasn't already replaced it — the generation tag guards that race.
        let state = app_for_task.state::<LlmState>();
        let mut streams = state.streams.lock().await;
        if streams.get(&id).map(|(g, _)| *g) == Some(my_gen) {
            streams.remove(&id);
        }
    });
    streams.insert(request_id, (my_gen, handle));
    Ok(())
}

/// Abort an in-flight stream (if any) and emit a terminal `done` frame so the UI settles.
#[tauri::command]
pub async fn llm_cancel<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LlmState>,
    request_id: String,
) -> Result<(), String> {
    if let Some((_, handle)) = state.streams.lock().await.remove(&request_id) {
        handle.abort();
        log::info("llm", "stream cancelled")
            .field("id", &request_id)
            .emit();
        emit_delta(&app, &request_id, "", true, None);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.into(),
            content: content.into(),
        }
    }

    #[test]
    fn endpoints_per_provider() {
        assert_eq!(
            chat_endpoint("anthropic", "https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            chat_endpoint("openai", "https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            chat_endpoint("ollama", "http://localhost:11434"),
            "http://localhost:11434/api/chat"
        );
        assert_eq!(
            models_endpoint("ollama", "http://localhost:11434"),
            "http://localhost:11434/api/tags"
        );
    }

    #[test]
    fn effective_base_defaults_and_trims() {
        let mut cfg = LlmConfig {
            provider: "anthropic".into(),
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            insecure: false,
            temperature: 0.7,
            max_tokens: 1024,
            agent_control: false,
            stt_model: String::new(),
            tts_model: String::new(),
            tts_voice: String::new(),
        };
        assert_eq!(effective_base(&cfg), "https://api.anthropic.com");
        cfg.base_url = "http://localhost:11434/".into();
        assert_eq!(effective_base(&cfg), "http://localhost:11434");
    }

    #[test]
    fn anthropic_body_lifts_system_and_coerces_roles() {
        let messages = vec![
            msg("system", "you are terse"),
            msg("user", "hi"),
            msg("tool", "noise"), // non-assistant -> user
        ];
        let body = build_chat_body("anthropic", "claude", &messages, 0.5, 200, false);
        assert_eq!(body["system"], "you are terse");
        assert_eq!(body["max_tokens"], 200);
        let arr = body["messages"].as_array().unwrap();
        // system is lifted out, so only the two non-system turns remain
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["role"], "user");
        assert_eq!(arr[1]["role"], "user"); // coerced from "tool"
    }

    #[test]
    fn anthropic_clamps_temperature_to_one() {
        let body = build_chat_body("anthropic", "claude", &[msg("user", "hi")], 1.7, 200, false);
        assert_eq!(body["temperature"], 1.0);
        // OpenAI is NOT clamped (it accepts up to 2).
        let oai = build_chat_body("openai", "gpt", &[msg("user", "hi")], 1.7, 200, false);
        assert_eq!(oai["temperature"], 1.7);
    }

    #[test]
    fn openai_body_keeps_system_in_list_and_max_tokens() {
        let messages = vec![msg("system", "sys"), msg("user", "q")];
        let body = build_chat_body("openai", "gpt", &messages, 0.5, 200, true);
        let arr = body["messages"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["role"], "system");
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 200);
    }

    #[test]
    fn ollama_body_uses_options() {
        let body = build_chat_body("ollama", "llama3.2", &[msg("user", "q")], 0.3, 64, false);
        assert_eq!(body["options"]["temperature"], 0.3);
        assert_eq!(body["options"]["num_predict"], 64);
    }

    #[test]
    fn parse_text_per_provider() {
        let anth = serde_json::json!({ "content": [ { "type": "text", "text": "he" }, { "type": "text", "text": "llo" } ] });
        assert_eq!(
            parse_chat_text("anthropic", &anth).as_deref(),
            Some("hello")
        );
        let oai = serde_json::json!({ "choices": [ { "message": { "content": "hi there" } } ] });
        assert_eq!(parse_chat_text("openai", &oai).as_deref(), Some("hi there"));
        let oll = serde_json::json!({ "message": { "content": "yo" } });
        assert_eq!(parse_chat_text("ollama", &oll).as_deref(), Some("yo"));
        // empty -> None (so the caller surfaces "no text" rather than an empty string)
        assert_eq!(parse_chat_text("openai", &serde_json::json!({})), None);
    }

    #[test]
    fn parse_models_per_provider() {
        let oai = serde_json::json!({ "data": [ { "id": "gpt-4o" }, { "id": "gpt-4o-mini" } ] });
        let m = parse_models("openai", &oai);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].id, "gpt-4o");
        let oll = serde_json::json!({ "models": [ { "name": "llama3.2" } ] });
        assert_eq!(parse_models("ollama", &oll)[0].id, "llama3.2");
    }

    #[test]
    fn uses_completion_tokens_matches_next_gen_families() {
        for m in [
            "gpt-5",
            "gpt-5-nano",
            "gpt-5.1",
            "o1",
            "o1-mini",
            "o3-mini",
            "o4-mini",
        ] {
            assert!(
                uses_completion_tokens(m),
                "{m} should use max_completion_tokens"
            );
        }
        for m in ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "llama3.2", ""] {
            assert!(!uses_completion_tokens(m), "{m} should keep max_tokens");
        }
    }

    #[test]
    fn openai_body_picks_the_right_token_param_per_model() {
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: "hi".into(),
        }];
        // Legacy model: temperature + max_tokens, no max_completion_tokens.
        let legacy = build_chat_body("openai", "gpt-4o-mini", &msgs, 0.5, 100, false);
        assert_eq!(legacy["max_tokens"], 100);
        assert_eq!(legacy["temperature"], 0.5);
        assert!(legacy.get("max_completion_tokens").is_none());
        // Next-gen model: max_completion_tokens, and NO max_tokens / NO temperature (both 400 there).
        let next = build_chat_body("openai", "gpt-5-nano", &msgs, 0.5, 100, false);
        assert_eq!(next["max_completion_tokens"], 100);
        assert!(next.get("max_tokens").is_none());
        assert!(next.get("temperature").is_none());
    }

    #[test]
    fn provider_error_extracts_message() {
        let v = serde_json::json!({ "error": { "message": "invalid api key" } });
        assert_eq!(provider_error(&v).as_deref(), Some("invalid api key"));
        let v2 = serde_json::json!({ "error": "model not found" });
        assert_eq!(provider_error(&v2).as_deref(), Some("model not found"));
    }

    #[test]
    fn openai_sse_lines() {
        assert_eq!(
            stream_event_from_line(
                "openai",
                "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}"
            ),
            StreamEvent::Token("Hi".into())
        );
        assert_eq!(
            stream_event_from_line("openai", "data: [DONE]"),
            StreamEvent::Done
        );
        // a role-only opening delta carries no content -> Ignore
        assert_eq!(
            stream_event_from_line(
                "openai",
                "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}"
            ),
            StreamEvent::Ignore
        );
        assert_eq!(stream_event_from_line("openai", ""), StreamEvent::Ignore);
    }

    #[test]
    fn anthropic_sse_lines() {
        assert_eq!(
            stream_event_from_line(
                "anthropic",
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}"
            ),
            StreamEvent::Token("Hel".into())
        );
        assert_eq!(
            stream_event_from_line("anthropic", "data: {\"type\":\"message_stop\"}"),
            StreamEvent::Done
        );
        // `event:` lines are ignored (anthropic sends both event: and data:)
        assert_eq!(
            stream_event_from_line("anthropic", "event: content_block_delta"),
            StreamEvent::Ignore
        );
    }

    #[test]
    fn ollama_stream_lines() {
        assert_eq!(
            stream_event_from_line(
                "ollama",
                "{\"message\":{\"content\":\"yo\"},\"done\":false}"
            ),
            StreamEvent::Token("yo".into())
        );
        assert_eq!(
            stream_event_from_line("ollama", "{\"message\":{\"content\":\"\"},\"done\":true}"),
            StreamEvent::Done
        );
    }

    #[test]
    fn transcription_seams() {
        assert_eq!(
            transcribe_endpoint("https://api.openai.com/v1"),
            "https://api.openai.com/v1/audio/transcriptions"
        );
        assert!(supports_transcription("openai"));
        assert!(!supports_transcription("anthropic"));
        assert!(!supports_transcription("ollama"));
        assert_eq!(mime_ext("audio/webm;codecs=opus"), "webm");
        assert_eq!(mime_ext("audio/wav"), "wav");
        assert_eq!(mime_ext("audio/mp4"), "m4a");
        assert_eq!(mime_ext("application/octet-stream"), "webm"); // fallback
        assert_eq!(
            parse_transcription(&serde_json::json!({ "text": "hello world" })).as_deref(),
            Some("hello world")
        );
        assert_eq!(
            parse_transcription(&serde_json::json!({ "text": "" })),
            None
        );
    }

    #[test]
    fn needs_key_only_for_keyed_providers() {
        assert!(needs_key("anthropic"));
        assert!(needs_key("openai"));
        assert!(!needs_key("ollama"));
    }

    #[test]
    fn config_defaults_keep_a_minimal_json_valid() {
        let cfg: LlmConfig = serde_json::from_str(r#"{ "provider": "anthropic" }"#).unwrap();
        assert_eq!(cfg.temperature, 0.7);
        assert_eq!(cfg.max_tokens, 1024);
        assert!(cfg.api_key.is_empty());
    }

    #[test]
    fn status_never_serializes_the_api_key() {
        let mut providers = HashMap::new();
        providers.insert(
            "openai".to_string(),
            ProviderStatus {
                base_url: "https://api.openai.com/v1".into(),
                model: "gpt-4o-mini".into(),
                has_key: true,
                insecure: false,
                stt_model: String::new(),
                tts_model: String::new(),
                tts_voice: String::new(),
            },
        );
        let v = serde_json::to_value(LlmStatus {
            configured: true,
            active: "openai".into(),
            providers,
            temperature: 0.7,
            max_tokens: 1024,
            agent_control: false,
        })
        .unwrap();
        assert!(v.get("api_key").is_none() && v.get("apiKey").is_none());
        assert_eq!(v["providers"]["openai"]["hasKey"], true);
        assert_eq!(
            v["providers"]["openai"]["baseUrl"],
            "https://api.openai.com/v1"
        );
        assert_eq!(v["maxTokens"], 1024);
    }

    #[test]
    fn migrates_legacy_flat_config_into_providers_map() {
        // A pre-multi-provider file (no `providers` key) → one entry, active = its provider, globals kept.
        let file = parse_config_json(
			r#"{ "provider": "anthropic", "api_key": "sk-x", "model": "claude-x", "max_tokens": 2048 }"#,
		)
		.unwrap();
        assert_eq!(file.active, "anthropic");
        assert_eq!(file.max_tokens, 2048);
        let entry = file.providers.get("anthropic").unwrap();
        assert_eq!(entry.api_key, "sk-x");
        assert_eq!(entry.model, "claude-x");
        // The resolved active config flattens the entry + the globals back together.
        let cfg = file.resolve_active();
        assert_eq!(cfg.provider, "anthropic");
        assert_eq!(cfg.api_key, "sk-x");
        assert_eq!(cfg.max_tokens, 2048);
    }

    #[test]
    fn parses_new_multi_provider_config() {
        let file = parse_config_json(
            r#"{ "active": "ollama", "providers": { "ollama": { "model": "llama3.2" }, "openai": { "api_key": "k", "stt_model": "whisper-1" } } }"#,
        )
        .unwrap();
        assert_eq!(file.active, "ollama");
        assert_eq!(file.providers.len(), 2);
        assert_eq!(file.providers["openai"].stt_model, "whisper-1");
        // Switching the resolved provider picks a different entry — both stay authenticated.
        assert_eq!(file.resolve("openai").api_key, "k");
        assert_eq!(file.resolve("ollama").model, "llama3.2");
    }

    #[test]
    fn tts_seams() {
        assert_eq!(
            tts_endpoint("https://api.openai.com/v1"),
            "https://api.openai.com/v1/audio/speech"
        );
        assert!(supports_tts("openai"));
        assert!(!supports_tts("anthropic"));
        assert!(!supports_tts("ollama"));
        let body = build_tts_body("tts-1", "alloy", "hello");
        assert_eq!(body["model"], "tts-1");
        assert_eq!(body["voice"], "alloy");
        assert_eq!(body["input"], "hello");
        assert_eq!(body["response_format"], "mp3");
    }
}
