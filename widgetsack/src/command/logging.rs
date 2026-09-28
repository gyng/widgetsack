use crate::log;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

/// Append a window's diagnostics summary to the rotating log file (the memory TRAIL). Each window calls
/// this on an interval (lib/diag.ts `startMemoryTrail`); because it lands on disk, the run-up to an
/// unattended overnight OOM survives the crash — read the last `memtrail` lines to see which metric was
/// climbing. Logged at info so it persists in release builds; the window label is attached as a field.
#[tauri::command]
pub async fn log_diag(window: tauri::WebviewWindow, summary: String) {
    log::info("memtrail", summary)
        .field("window", window.label())
        .emit();
}

/// Map a frontend log level string to a backend [`log::LogLevel`]. Only "error" and "warn" are
/// distinguished; anything else (incl. "info", "log", "", or a typo) falls back to `Info` — a
/// client log is worth keeping even if its severity label is off. Pure seam (tested below).
fn client_log_level(level: &str) -> log::LogLevel {
    match level {
        "error" => log::LogLevel::Error,
        "warn" => log::LogLevel::Warn,
        _ => log::LogLevel::Info,
    }
}

/// Cap a client-supplied string at `max` CHARS (not bytes — never splits a UTF-8 scalar), marking
/// the cut with a trailing `…`. The webview side of `log_client` is app code, but a buggy render
/// loop stringifying a huge object into `message` would otherwise churn straight through the log's
/// 1 MiB rotation. Pure seam (tested below).
fn truncate_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// Caps for `log_client` fields: generous for a diagnostic line, tiny next to the 1 MiB rotation.
const CLIENT_LOG_MESSAGE_MAX: usize = 4096;
const CLIENT_LOG_COMPONENT_MAX: usize = 64;

/// Per-(window, component, message) ceiling for `log_client`: past this many identical lines in
/// one window the rest are counted, and the next line that gets through is preceded by a
/// "suppressed N" record. A render loop that logs the same error every frame is otherwise 60
/// records/s into the ring buffer, the file and the studio's log stream.
const CLIENT_LOG_MAX_PER_SEC: u32 = 20;
const CLIENT_LOG_WINDOW: Duration = Duration::from_secs(1);
/// Distinct keys tracked at once; past this the table is cleared (a bound, not a policy).
const CLIENT_LOG_KEYS_MAX: usize = 512;

/// Fixed-window per-key rate limiter. Pure seam (tested): `check(key, now)` says whether this
/// line may be logged and, if so, how many identical lines were suppressed since the last one that
/// got through (0 = none — the common case).
struct ClientLogLimiter {
    max_per_window: u32,
    window: Duration,
    window_start: Option<Instant>,
    /// key → (allowed in this window, suppressed since the last allowed line — carried across windows)
    counts: HashMap<String, (u32, u32)>,
}

#[derive(Debug, PartialEq, Eq)]
enum LogVerdict {
    Allow { suppressed_before: u32 },
    Suppress,
}

impl ClientLogLimiter {
    fn new(max_per_window: u32, window: Duration) -> Self {
        ClientLogLimiter {
            max_per_window,
            window,
            window_start: None,
            counts: HashMap::new(),
        }
    }

    fn check(&mut self, key: String, now: Instant) -> LogVerdict {
        let rolled = self
            .window_start
            .is_none_or(|start| now.duration_since(start) >= self.window);
        if rolled {
            self.window_start = Some(now);
            // New window: everyone gets a fresh allowance; keep only the keys still owed a
            // "suppressed N" line so the table doesn't grow with one-off messages.
            self.counts.retain(|_, (allowed, suppressed)| {
                *allowed = 0;
                *suppressed > 0
            });
        }
        if self.counts.len() >= CLIENT_LOG_KEYS_MAX && !self.counts.contains_key(&key) {
            self.counts.clear();
        }
        let (allowed, suppressed) = self.counts.entry(key).or_insert((0, 0));
        if *allowed < self.max_per_window {
            *allowed += 1;
            LogVerdict::Allow {
                suppressed_before: std::mem::take(suppressed),
            }
        } else {
            *suppressed = suppressed.saturating_add(1);
            LogVerdict::Suppress
        }
    }
}

fn client_log_limiter() -> &'static std::sync::Mutex<ClientLogLimiter> {
    static LIMITER: std::sync::OnceLock<std::sync::Mutex<ClientLogLimiter>> =
        std::sync::OnceLock::new();
    LIMITER.get_or_init(|| {
        std::sync::Mutex::new(ClientLogLimiter::new(
            CLIENT_LOG_MAX_PER_SEC,
            CLIENT_LOG_WINDOW,
        ))
    })
}

/// Persist a FRONTEND failure into the backend log pipeline (console + ring buffer + rotating file +
/// `log` event). Frontend errors — an overlay reconcile that threw, a failed invoke — otherwise live
/// only in the webview's console and VANISH when that webview dies, which is exactly the class of
/// failure that's hardest to diagnose after the fact (the overnight forensics of 2026-07-10). This
/// lands them on disk. `level` picks the severity (see `client_log_level`); the `component` and the
/// calling `window`'s label are attached as fields. Target is the fixed "client" subsystem (the log
/// builders take a `&'static str` target, so the dynamic part goes in a field). Optional structured
/// `fields` are capped to leave room for the reserved `component` and `window` tags. Mirrors `log_diag`.
/// `async` so it never runs on the UI thread (a sync command would), and rate-limited per
/// (window, component, message) — see `ClientLogLimiter`.
#[tauri::command]
pub async fn log_client(
    window: tauri::WebviewWindow,
    level: String,
    component: String,
    message: String,
    fields: Option<std::collections::BTreeMap<String, String>>,
) {
    let message = truncate_chars(&message, CLIENT_LOG_MESSAGE_MAX);
    let component = truncate_chars(&component, CLIENT_LOG_COMPONENT_MAX);
    let label = window.label();
    let key = format!("{label}\u{0}{component}\u{0}{message}");
    let verdict = client_log_limiter()
        .lock()
        .map(|mut l| l.check(key, Instant::now()))
        .unwrap_or(LogVerdict::Allow {
            suppressed_before: 0,
        });
    let suppressed_before = match verdict {
        LogVerdict::Suppress => return,
        LogVerdict::Allow { suppressed_before } => suppressed_before,
    };
    if suppressed_before > 0 {
        log::warn("client", "suppressed repeated client log lines")
            .field("suppressed", suppressed_before)
            .field("component", &component)
            .field("window", label)
            .emit();
    }
    let mut entry = match client_log_level(&level) {
        log::LogLevel::Error => log::error("client", message),
        log::LogLevel::Warn => log::warn("client", message),
        _ => log::info("client", message),
    };
    for (key, value) in fields.into_iter().flatten().take(14) {
        entry = entry.field(&key, value);
    }
    entry
        .field("component", component)
        .field("window", label)
        .emit();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::LogLevel;

    #[test]
    fn client_log_limiter_caps_per_key_per_window_and_reports_the_gap() {
        let t0 = Instant::now();
        let mut l = ClientLogLimiter::new(3, Duration::from_secs(1));
        let key = || "main\0Gauge\0boom".to_string();
        for _ in 0..3 {
            assert_eq!(
                l.check(key(), t0),
                LogVerdict::Allow {
                    suppressed_before: 0
                }
            );
        }
        assert_eq!(l.check(key(), t0), LogVerdict::Suppress);
        assert_eq!(l.check(key(), t0), LogVerdict::Suppress);
        // A different key is independent.
        assert_eq!(
            l.check("studio\0Gauge\0boom".to_string(), t0),
            LogVerdict::Allow {
                suppressed_before: 0
            }
        );
        // Next window: the first line through carries the count of what was dropped.
        assert_eq!(
            l.check(key(), t0 + Duration::from_secs(1)),
            LogVerdict::Allow {
                suppressed_before: 2
            }
        );
        assert_eq!(
            l.check(key(), t0 + Duration::from_secs(1)),
            LogVerdict::Allow {
                suppressed_before: 0
            }
        );
    }

    #[test]
    fn truncate_chars_caps_at_chars_not_bytes() {
        assert_eq!(truncate_chars("short", 10), "short");
        assert_eq!(truncate_chars("abcdef", 3), "abc…");
        // Multi-byte scalars: 3 CHARS, never a split UTF-8 sequence.
        assert_eq!(truncate_chars("日本語です", 3), "日本語…");
        assert_eq!(truncate_chars("", 5), "");
    }

    #[test]
    fn client_log_level_maps_error_warn_else_info() {
        assert_eq!(client_log_level("error"), LogLevel::Error);
        assert_eq!(client_log_level("warn"), LogLevel::Warn);
        // Anything else — "info", an unknown level, or a typo — is kept at info rather than dropped.
        assert_eq!(client_log_level("info"), LogLevel::Info);
        assert_eq!(client_log_level("debug"), LogLevel::Info);
        assert_eq!(client_log_level(""), LogLevel::Info);
        assert_eq!(client_log_level("ERROR"), LogLevel::Info); // case-sensitive by design
    }
}
