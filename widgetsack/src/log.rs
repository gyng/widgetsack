//! Structured logging for the backend. Replaces ad-hoc `println!`/`eprintln!` with a typed
//! `LogRecord` (level + `target` subsystem + message + stringified `fields`) that is, in one place:
//!   1. printed to the console (dev convenience — warn/error to stderr, else stdout),
//!   2. pushed to a bounded in-memory ring buffer,
//!   3. queued to a dedicated writer thread that appends it to the rotating log file, and
//!   4. emitted to the STUDIO webview (if open) as a `log` event.
//!
//! So a future in-app logs UI can both stream new entries (the `log` event via `subscribeLogs`) and
//! load the backlog (the `get_logs` command). The schema is mirrored in client/src/lib/core/logs.ts
//! (AGENTS.md §5 — keep both sides in sync).
//!
//! The file append is OFF the calling thread on purpose: a log call can come from the UI thread
//! (every sync command, the tray, window events) and a synchronous open/append/rotate on a slow
//! disk — or one held by an AV scan — would stall it. The writer queue is bounded; on overflow
//! lines are counted and dropped, and one "suppressed N lines" record is written when it recovers.
//!
//! Usage: `log::info("gsmtc", "session created").field("session_id", id).emit();`

use std::cell::Cell;
use std::collections::{BTreeMap, VecDeque};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
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

/// Lines the writer thread may have queued before callers start dropping (a burst from a render
/// loop logging at 60 Hz, or a stalled disk). Each line is a few hundred bytes — ~1 MB worst case.
const LOG_QUEUE_CAP: usize = 4096;

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
/// (append/rotate) are guarded by the inner `Mutex` so the writer thread and the panic hook's
/// direct write don't interleave.
static LOG_FILE: OnceLock<Mutex<PathBuf>> = OnceLock::new();
/// Producer side of the bounded queue feeding the `log-writer` thread. Set in `init`.
static FILE_TX: OnceLock<SyncSender<String>> = OnceLock::new();
/// Lines dropped because the writer queue was full, not yet reported (see `Overflow`).
static OVERFLOW: Overflow = Overflow::new();

fn buffer() -> &'static Mutex<VecDeque<LogRecord>> {
    BUFFER.get_or_init(|| Mutex::new(VecDeque::with_capacity(BUFFER_CAP)))
}

/// The absolute path of the rotating on-disk log, once `init` resolved it (`None` before / when
/// the app log dir is unavailable). For a "reveal log" command.
pub fn log_file_path() -> Option<PathBuf> {
    LOG_FILE
        .get()
        .and_then(|lock| lock.lock().ok())
        .map(|path| path.clone())
}

/// Wire the logger to the app so records also stream to the webview AND append to a rotating file
/// under the app log dir (via the `log-writer` thread started here). Call once in `setup`. Logging
/// works before this (console + buffer + the panic hook's eprintln) — it just can't emit the `log`
/// event or write the file until wired.
pub fn init(app: AppHandle) {
    // Resolve + ensure the log dir before storing the handle (file logging needs the path).
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if LOG_FILE.set(Mutex::new(dir.join(LOG_FILE_NAME))).is_ok() {
            let (tx, rx) = sync_channel::<String>(LOG_QUEUE_CAP);
            if FILE_TX.set(tx).is_ok() {
                spawn_writer(rx);
            }
        }
    }
    let _ = APP.set(app);
}

/// The dedicated file-append thread: drains the queue for the app's lifetime. The only place a
/// normal log line touches the disk.
fn spawn_writer(rx: Receiver<String>) {
    let _ = std::thread::Builder::new()
        .name("log-writer".to_string())
        .spawn(move || {
            for line in rx {
                write_line_to_file(&line);
            }
        });
}

/// Counter of file lines dropped on queue overflow, reported once on recovery. Pure seam (tested):
/// `note_dropped` on every `Full`, `take` when a send succeeds again — a non-zero take is the count
/// for the one "suppressed N lines" record.
struct Overflow(AtomicU64);

impl Overflow {
    const fn new() -> Self {
        Overflow(AtomicU64::new(0))
    }
    fn note_dropped(&self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
    fn take(&self) -> u64 {
        self.0.swap(0, Ordering::Relaxed)
    }
    fn restore(&self, n: u64) {
        self.0.fetch_add(n, Ordering::Relaxed);
    }
}

/// The record written when the writer queue recovers after dropping `dropped` lines.
fn suppressed_record(dropped: u64) -> LogRecord {
    LogRecord {
        ts_ms: now_ms(),
        level: LogLevel::Warn,
        target: "log".to_string(),
        message: format!("suppressed {dropped} log lines (file writer queue was full)"),
        fields: BTreeMap::from([("dropped".to_string(), dropped.to_string())]),
    }
}

/// Queue one serialized JSON line for the writer thread. Never blocks: a full queue drops the line
/// and counts it; the next line that fits is preceded by a "suppressed N lines" record so the gap is
/// visible in the file. No-op before `init` (nothing to write to).
fn enqueue_file_line(json: String) {
    let Some(tx) = FILE_TX.get() else {
        return;
    };
    let dropped = OVERFLOW.take();
    if dropped > 0 {
        let ok = serde_json::to_string(&suppressed_record(dropped))
            .ok()
            .is_some_and(|marker| tx.try_send(marker).is_ok());
        if !ok {
            OVERFLOW.restore(dropped);
        }
    }
    match tx.try_send(json) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => OVERFLOW.note_dropped(),
        Err(TrySendError::Disconnected(_)) => {}
    }
}

/// Append one already-serialized JSON line to the rotating log file, rotating first if it has grown
/// past the size cap. Runs on the writer thread (and, directly, from the panic hook). Best-effort:
/// any I/O error is swallowed (the console + buffer still have it).
fn write_line_to_file(line: &str) {
    let Some(lock) = LOG_FILE.get() else {
        return; // not wired yet (early startup / tests) — nothing to write to.
    };
    let Ok(path) = lock.lock() else {
        return; // a poisoned lock shouldn't take logging down.
    };
    write_line_at(&path, line);
}

fn write_line_at(path: &std::path::Path, line: &str) {
    // Rotate when the current file is over the cap: move it to `<name>.1` (overwriting any prior
    // backup), then start a fresh primary. A missing file is fine (first write).
    if std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) >= LOG_FILE_MAX_BYTES {
        let backup = path.with_extension("log.1");
        let _ = std::fs::rename(path, &backup);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

thread_local! {
    /// Re-entrancy guard for `log_panic`: a panic raised while the hook itself runs on this thread
    /// (serde, an allocation failure, a poisoned lock) must not recurse into the hook.
    static IN_PANIC_HOOK: Cell<bool> = const { Cell::new(false) };
}

/// Record a panic into the same pipeline a normal log uses so it is never silent: format the
/// location + message, print it to stderr, append it to the rotating file DIRECTLY (not via the
/// writer queue — the process may be about to die; and even before/without the app handle), and
/// emit the `log` event from a fresh thread if the webview is wired (never from the panicking
/// thread: it may hold a Tauri lock that the emit needs, e.g. a panic inside an event handler).
/// Installed as the std panic hook at the very start of `main` (so a panic anywhere — including
/// before `init` — is captured).
pub fn log_panic(info: &std::panic::PanicHookInfo<'_>) {
    if IN_PANIC_HOOK.with(|flag| flag.replace(true)) {
        eprintln!("panic while handling a panic: {info}");
        return;
    }
    log_panic_inner(info);
    IN_PANIC_HOOK.with(|flag| flag.set(false));
}

fn log_panic_inner(info: &std::panic::PanicHookInfo<'_>) {
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

    // Always to stderr + the file (the file path may be set even if the webview never wired). The
    // file lock is only TRIED: if this very thread panicked inside the writer while holding it, a
    // blocking lock would deadlock the hook.
    let line = console_line(&record);
    eprintln!("{line}");
    if let Ok(json) = serde_json::to_string(&record)
        && let Some(lock) = LOG_FILE.get()
        && let Ok(path) = lock.try_lock()
    {
        write_line_at(&path, &json);
    }
    // And to the webview, if it is up (a panic on a worker thread can still be surfaced in-app) —
    // from a fresh thread, so a panic inside Tauri's own event machinery can't deadlock on itself.
    if let Some(app) = APP.get() {
        let app = app.clone();
        let _ = std::thread::Builder::new()
            .name("panic-emit".to_string())
            .spawn(move || emit_to_studio(&app, &record));
    }
}

/// Stream a record to the studio window's logs UI. Only the studio subscribes (the overlays never
/// show logs), so nothing is emitted at all while it is closed — no serialization, no per-webview
/// dispatch for a record nobody listens to.
fn emit_to_studio(app: &AppHandle, record: &LogRecord) {
    if app.get_webview_window("studio").is_some() {
        let _ = app.emit_to("studio", LOG_EVENT, record);
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

    // 3. rotating file — one JSON line per record under the app log dir, via the writer thread
    //    (no-op before `init`).
    if let Ok(json) = serde_json::to_string(&record) {
        enqueue_file_line(json);
    }

    // 4. live stream to the studio, once wired (no-op before `init`, e.g. early startup / tests).
    if let Some(app) = APP.get() {
        emit_to_studio(app, &record);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overflow_counts_drops_and_reports_them_once() {
        let o = Overflow::new();
        assert_eq!(o.take(), 0);
        o.note_dropped();
        o.note_dropped();
        assert_eq!(o.take(), 2);
        assert_eq!(o.take(), 0, "reported once, then clear");
        // A marker that itself failed to queue puts the count back for the next attempt.
        o.restore(2);
        o.note_dropped();
        assert_eq!(o.take(), 3);
    }

    #[test]
    fn suppressed_record_names_the_gap() {
        let r = suppressed_record(17);
        assert_eq!(r.level, LogLevel::Warn);
        assert_eq!(r.target, "log");
        assert!(r.message.contains("17"), "{}", r.message);
        assert_eq!(r.fields.get("dropped").map(String::as_str), Some("17"));
    }

    #[test]
    fn write_line_at_appends_and_rotates_past_the_cap() {
        let dir = std::env::temp_dir().join(format!(
            "widgetsack-log-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("widgetsack.log");
        write_line_at(&path, "one");
        write_line_at(&path, "two");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "one\ntwo\n");
        // Grow the primary past the cap: the next write rotates it to `.log.1` and starts fresh.
        std::fs::write(&path, vec![b'x'; LOG_FILE_MAX_BYTES as usize]).unwrap();
        write_line_at(&path, "three");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "three\n");
        assert_eq!(
            std::fs::metadata(dir.join("widgetsack.log.1"))
                .unwrap()
                .len(),
            LOG_FILE_MAX_BYTES
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
