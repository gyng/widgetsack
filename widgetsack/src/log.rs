//! Structured logging for the backend. Replaces ad-hoc `println!`/`eprintln!` with a typed
//! `LogRecord` (level + `target` subsystem + message + stringified `fields`) that is, in one place:
//!   1. printed to the console (dev convenience — warn/error to stderr, else stdout),
//!   2. pushed to a bounded in-memory ring buffer, and
//!   3. emitted to the webview as a `log` event.
//!
//! So a future in-app logs UI can both stream new entries (the `log` event via `subscribeLogs`) and
//! load the backlog (the `get_logs` command). The schema is mirrored in client/src/lib/core/logs.ts
//! (AGENTS.md §5 — keep both sides in sync).
//!
//! Usage: `log::info("gsmtc", "session created").field("session_id", id).emit();`

use std::collections::{BTreeMap, VecDeque};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Tauri event name carrying one `LogRecord` to the webview (the logs UI's live stream).
/// The string itself lives in bridge.rs with the rest of the bridge contract.
pub use crate::bridge::LOG_EVENT;

/// Most recent entries retained for a UI that opens after the fact. Oldest drop past this.
const BUFFER_CAP: usize = 1000;

/// File the JSON-lines log is appended to (under the app log dir). Set in `init`.
const LOG_FILE_NAME: &str = "widgetsack.log";

/// Rotate the log file to `widgetsack.log.1` once it grows past this (~1 MB) so it can't grow
/// unbounded. One backup is kept (the previous backup is overwritten on each rotation).
const LOG_FILE_MAX_BYTES: u64 = 1_048_576;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn label(self) -> &'static str {
        match self {
            LogLevel::Trace => "TRACE",
            LogLevel::Debug => "DEBUG",
            LogLevel::Info => "INFO ",
            LogLevel::Warn => "WARN ",
            LogLevel::Error => "ERROR",
        }
    }
}

/// One structured log entry. `target` names the subsystem ("gsmtc", "sensors", "ha", "watch", …);
/// `fields` are arbitrary structured key/values (stringified) for filtering/inspection in the UI.
#[derive(Clone, Debug, Serialize)]
pub struct LogRecord {
    pub ts_ms: u64,
    pub level: LogLevel,
    pub target: String,
    pub message: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
}

static BUFFER: OnceLock<Mutex<VecDeque<LogRecord>>> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
/// Absolute path of the on-disk log, resolved in `init` from the app log dir. Serialized writes
/// (append/rotate) are guarded by the inner `Mutex` so concurrent log calls don't interleave.
static LOG_FILE: OnceLock<Mutex<PathBuf>> = OnceLock::new();

fn buffer() -> &'static Mutex<VecDeque<LogRecord>> {
    BUFFER.get_or_init(|| Mutex::new(VecDeque::with_capacity(BUFFER_CAP)))
}

/// Wire the logger to the app so records also stream to the webview AND append to a rotating file
/// under the app log dir. Call once in `setup`. Logging works before this (console + buffer + the
/// panic hook's eprintln) — it just can't emit the `log` event or write the file until wired.
pub fn init(app: AppHandle) {
    // Resolve + ensure the log dir before storing the handle (file logging needs the path).
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = LOG_FILE.set(Mutex::new(dir.join(LOG_FILE_NAME)));
    }
    let _ = APP.set(app);
}

/// Append one already-serialized JSON line to the rotating log file, rotating first if it has grown
/// past the size cap. Best-effort: any I/O error is swallowed (the console + buffer still have it).
fn append_to_file(line: &str) {
    let Some(lock) = LOG_FILE.get() else {
        return; // not wired yet (early startup / tests) — nothing to write to.
    };
    let Ok(path) = lock.lock() else {
        return; // a poisoned lock shouldn't take logging down.
    };
    // Rotate when the current file is over the cap: move it to `<name>.1` (overwriting any prior
    // backup), then start a fresh primary. A missing file is fine (first write).
    if std::fs::metadata(&*path).map(|m| m.len()).unwrap_or(0) >= LOG_FILE_MAX_BYTES {
        let backup = path.with_extension("log.1");
        let _ = std::fs::rename(&*path, &backup);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&*path) {
        let _ = writeln!(f, "{line}");
    }
}

/// Record a panic into the same pipeline a normal log uses so it is never silent: format the
/// location + message, print it to stderr, append it to the rotating file (even before/without the
/// app handle), and emit the `log` event if the webview is wired. Installed as the std panic hook
/// at the very start of `main` (so a panic anywhere — including before `init` — is captured).
pub fn log_panic(info: &std::panic::PanicHookInfo<'_>) {
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_else(|| "unknown".to_string());
    let payload = info.payload();
    let message = payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "Box<dyn Any>".to_string());

    let record = LogRecord {
        ts_ms: now_ms(),
        level: LogLevel::Error,
        target: "panic".to_string(),
        message,
        fields: BTreeMap::from([("location".to_string(), location)]),
    };

    // Always to stderr + the file (the file path may be set even if the webview never wired).
    let line = console_line(&record);
    eprintln!("{line}");
    if let Ok(json) = serde_json::to_string(&record) {
        append_to_file(&json);
    }
    // And to the webview, if it is up (a panic on a worker thread can still be surfaced in-app).
    if let Some(app) = APP.get() {
        let _ = app.emit(LOG_EVENT, &record);
    }
}

/// Records below this level are dropped entirely (not printed/buffered/emitted). Debug builds keep
/// `debug` and up; release keeps `info` and up. `trace` is opt-in only by lowering this.
fn min_level() -> LogLevel {
    if cfg!(debug_assertions) {
        LogLevel::Debug
    } else {
        LogLevel::Info
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// An in-progress log entry: attach `field`s, then `emit`. Build via `info`/`warn`/`error`/etc.
#[must_use = "a LogBuilder does nothing until .emit() is called"]
pub struct LogBuilder {
    level: LogLevel,
    target: &'static str,
    message: String,
    fields: BTreeMap<String, String>,
}

impl LogBuilder {
    /// Attach a structured field (value is stringified via `Display`). Chainable.
    pub fn field(mut self, key: &str, value: impl std::fmt::Display) -> Self {
        self.fields.insert(key.to_string(), value.to_string());
        self
    }

    /// Finalize: stamp the time, then print + buffer + emit (subject to `min_level`).
    pub fn emit(self) {
        if self.level < min_level() {
            return;
        }
        dispatch(LogRecord {
            ts_ms: now_ms(),
            level: self.level,
            target: self.target.to_string(),
            message: self.message,
            fields: self.fields,
        });
    }
}

fn builder(level: LogLevel, target: &'static str, message: impl Into<String>) -> LogBuilder {
    LogBuilder {
        level,
        target,
        message: message.into(),
        fields: BTreeMap::new(),
    }
}

pub fn trace(target: &'static str, message: impl Into<String>) -> LogBuilder {
    builder(LogLevel::Trace, target, message)
}
pub fn debug(target: &'static str, message: impl Into<String>) -> LogBuilder {
    builder(LogLevel::Debug, target, message)
}
pub fn info(target: &'static str, message: impl Into<String>) -> LogBuilder {
    builder(LogLevel::Info, target, message)
}
pub fn warn(target: &'static str, message: impl Into<String>) -> LogBuilder {
    builder(LogLevel::Warn, target, message)
}
pub fn error(target: &'static str, message: impl Into<String>) -> LogBuilder {
    builder(LogLevel::Error, target, message)
}

/// A compact one-liner for the console / panic hook: `LEVEL target: message k=v …`.
fn console_line(record: &LogRecord) -> String {
    let mut line = format!(
        "{} {}: {}",
        record.level.label(),
        record.target,
        record.message
    );
    for (k, v) in &record.fields {
        line.push_str(&format!(" {k}={v}"));
    }
    line
}

fn dispatch(record: LogRecord) {
    // 1. console — a compact one-liner; warn/error to stderr, everything else to stdout.
    let line = console_line(&record);
    if record.level >= LogLevel::Warn {
        eprintln!("{line}");
    } else {
        println!("{line}");
    }

    // 2. ring buffer — drop oldest past the cap.
    if let Ok(mut buf) = buffer().lock() {
        while buf.len() >= BUFFER_CAP {
            buf.pop_front();
        }
        buf.push_back(record.clone());
    }

    // 3. rotating file — one JSON line per record under the app log dir (no-op before `init`).
    if let Ok(json) = serde_json::to_string(&record) {
        append_to_file(&json);
    }

    // 4. live stream to the webview, once wired (no-op before `init`, e.g. early startup / tests).
    if let Some(app) = APP.get() {
        let _ = app.emit(LOG_EVENT, &record);
    }
}

/// The buffered log backlog, oldest first — for a logs UI that opens after entries were produced.
#[tauri::command]
pub fn get_logs() -> Vec<LogRecord> {
    buffer()
        .lock()
        .map(|b| b.iter().cloned().collect())
        .unwrap_or_default()
}
