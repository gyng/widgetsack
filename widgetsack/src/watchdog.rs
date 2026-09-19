//! Main-thread stall watchdog: a diagnostic that makes UI-thread hangs visible in the log file.
//!
//! On 2026-09-18 Windows Error Reporting recorded an `AppHangTransient` for widgetsack while the
//! user was switching the primary monitor's HDMI input — the event loop stopped pumping messages
//! for 5+ seconds — and the app log had nothing to say about it: the panic hook only sees panics,
//! and nothing else records when the main thread stops answering. This module closes that gap.
//!
//! A dedicated thread posts a tiny closure to the main thread once a second (`run_on_main_thread`)
//! and waits for it to run. If the answer takes longer than `STALL_THRESHOLD` a `warn` line is
//! logged with the elapsed time — one when the stall is first noticed and one when the main
//! thread recovers, with the total — so a postmortem can line the stall up with the topology /
//! refit lines the overlays log around it. A merely slow round trip (`SLOW_THRESHOLD`) logs at
//! `info`. Cost: one no-op closure per second on the UI thread.
//!
//! The classification (when a pending ping becomes a stall, when an ack ends one) is the pure,
//! unit-tested `StallTracker`; the thread + Tauri dispatch is the thin outer shell.

use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Cadence of the main-thread ping.
const PING_INTERVAL: Duration = Duration::from_secs(1);
/// How often the watcher re-checks an unanswered ping (bounds the reporting latency).
const POLL: Duration = Duration::from_millis(250);
/// An unanswered ping this old is a stall (logged at `warn`).
const STALL_THRESHOLD_MS: u64 = 2_000;
/// A round trip this slow — but under the stall threshold — is logged at `info`.
const SLOW_THRESHOLD_MS: u64 = 500;

/// What the tracker wants logged after an observation.
#[derive(Debug, PartialEq, Eq)]
pub enum StallEvent {
    /// The oldest unanswered ping has been pending `pending_ms` — the main thread is stalled.
    Began { pending_ms: u64 },
    /// A stalled main thread answered again; the ping was outstanding `total_ms` in all.
    Ended { total_ms: u64 },
    /// Not a stall, but a slow round trip worth an `info` line.
    Slow { round_trip_ms: u64 },
}

/// Pure seam: turns "ping still pending for N ms" / "ping answered after N ms" observations into
/// at most one event each, reporting a stall exactly once when it begins and once when it ends.
#[derive(Debug)]
pub struct StallTracker {
    stall_threshold_ms: u64,
    slow_threshold_ms: u64,
    stalled: bool,
}

impl StallTracker {
    pub fn new(stall_threshold_ms: u64, slow_threshold_ms: u64) -> Self {
        Self {
            stall_threshold_ms,
            slow_threshold_ms,
            stalled: false,
        }
    }

    /// The current ping has been outstanding for `pending_ms` and is still unanswered.
    pub fn pending(&mut self, pending_ms: u64) -> Option<StallEvent> {
        if !self.stalled && pending_ms >= self.stall_threshold_ms {
            self.stalled = true;
            return Some(StallEvent::Began { pending_ms });
        }
        None
    }

    /// The current ping was answered after `round_trip_ms`.
    pub fn acked(&mut self, round_trip_ms: u64) -> Option<StallEvent> {
        if self.stalled {
            self.stalled = false;
            return Some(StallEvent::Ended {
                total_ms: round_trip_ms,
            });
        }
        if round_trip_ms >= self.slow_threshold_ms {
            return Some(StallEvent::Slow { round_trip_ms });
        }
        None
    }
}

/// Start the watchdog thread. Call once in `setup`. Best-effort: if the main thread can no longer
/// accept closures (event loop gone — shutdown) the thread simply ends.
pub fn run_main_thread_watchdog(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new()
        .name("watchdog".into())
        .spawn(move || {
            let mut tracker = StallTracker::new(STALL_THRESHOLD_MS, SLOW_THRESHOLD_MS);
            loop {
                let (tx, rx) = mpsc::channel::<()>();
                let sent = Instant::now();
                if app
                    .run_on_main_thread(move || {
                        let _ = tx.send(());
                    })
                    .is_err()
                {
                    return; // event loop unavailable — the app is shutting down
                }
                loop {
                    match rx.recv_timeout(POLL) {
                        Ok(()) => {
                            let ms = sent.elapsed().as_millis() as u64;
                            match tracker.acked(ms) {
                                Some(StallEvent::Ended { total_ms }) => {
                                    crate::log::warn("watchdog", "main thread recovered")
                                        .field("stall_ms", total_ms)
                                        .emit();
                                }
                                Some(StallEvent::Slow { round_trip_ms }) => {
                                    crate::log::info("watchdog", "main thread slow")
                                        .field("round_trip_ms", round_trip_ms)
                                        .emit();
                                }
                                _ => {}
                            }
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            let ms = sent.elapsed().as_millis() as u64;
                            if let Some(StallEvent::Began { pending_ms }) = tracker.pending(ms) {
                                crate::log::warn("watchdog", "main thread unresponsive")
                                    .field("pending_ms", pending_ms)
                                    .emit();
                            }
                        }
                        // The closure was dropped without running: the event loop is tearing down.
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                std::thread::sleep(PING_INTERVAL);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{StallEvent, StallTracker};

    #[test]
    fn reports_a_stall_once_when_it_begins_and_once_when_it_ends() {
        let mut t = StallTracker::new(2_000, 500);
        assert_eq!(t.pending(250), None);
        assert_eq!(t.pending(1_999), None);
        assert_eq!(
            t.pending(2_000),
            Some(StallEvent::Began { pending_ms: 2_000 })
        );
        // Still stalled: no repeat report while the same ping stays unanswered.
        assert_eq!(t.pending(4_500), None);
        assert_eq!(t.acked(6_100), Some(StallEvent::Ended { total_ms: 6_100 }));
        // Fully reset: the next stall reports again.
        assert_eq!(
            t.pending(2_500),
            Some(StallEvent::Began { pending_ms: 2_500 })
        );
    }

    #[test]
    fn a_fast_ack_is_silent_and_a_slow_one_is_info_not_a_stall() {
        let mut t = StallTracker::new(2_000, 500);
        assert_eq!(t.acked(12), None);
        assert_eq!(t.acked(499), None);
        assert_eq!(t.acked(500), Some(StallEvent::Slow { round_trip_ms: 500 }));
        // A slow ack that arrives before the stall threshold never counts as a stall ending.
        assert_eq!(
            t.acked(1_900),
            Some(StallEvent::Slow {
                round_trip_ms: 1_900
            })
        );
    }
}
