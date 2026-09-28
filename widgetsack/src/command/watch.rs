use crate::log;
use notify::Watcher;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::Emitter;

/// Where a watched-file change came from — the app's own `save_layout` (ignored by the watcher:
/// the save emitted `layout_changed` itself) or something else (an editor, a manual hot-fix, a
/// sync tool): the path that must keep live-reloading AND may need to respawn `main`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ChangeOrigin {
    SelfWrite,
    External,
}

/// After the first matching filesystem event, keep draining for this long so one logical change
/// (an atomic write is create-temp + rename + attribute events) becomes ONE reload.
const WATCH_DEBOUNCE: Duration = Duration::from_millis(150);

/// Drain `rx` until `until`, counting the items that pass `keep`. Pure over the channel (tested):
/// the coalescing half of the watcher, separated from notify + Tauri.
fn drain_burst<T>(
    rx: &std::sync::mpsc::Receiver<T>,
    until: Instant,
    mut keep: impl FnMut(&T) -> bool,
) -> usize {
    let mut extra = 0;
    loop {
        let now = Instant::now();
        if now >= until {
            return extra;
        }
        match rx.recv_timeout(until - now) {
            Ok(item) => {
                if keep(&item) {
                    extra += 1;
                }
            }
            Err(_) => return extra, // timed out (burst over) or the sender is gone
        }
    }
}

/// Shared loop behind `watch_themes`/`watch_layout`/`watch_controls`: watch `dir` (non-recursive)
/// on a dedicated thread for the app's lifetime. For every burst of filesystem events that pass
/// `filter` (coalesced over `WATCH_DEBOUNCE`), ask `classify` where the change came from: an
/// `External` change emits `event_name` then runs `on_external` (the layout watcher's main-respawn
/// hook; a no-op for the others); a `SelfWrite` is ignored (the writer already notified). `label`
/// tags the log lines. Best-effort: logs and returns on watcher failure, leaving live reload off
/// for that file.
pub(super) fn watch_and_emit(
    app: tauri::AppHandle,
    dir: PathBuf,
    label: &'static str,
    event_name: &'static str,
    filter: impl Fn(&notify::Event) -> bool + Send + 'static,
    classify: impl Fn(&tauri::AppHandle) -> ChangeOrigin + Send + 'static,
    on_external: impl Fn(&tauri::AppHandle) + Send + 'static,
) {
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) {
            Ok(watcher) => watcher,
            Err(err) => {
                log::error("watch", format!("{label} watcher init failed"))
                    .field("error", err)
                    .emit();
                return;
            }
        };
        if let Err(err) = watcher.watch(&dir, notify::RecursiveMode::NonRecursive) {
            log::error("watch", format!("{label} watch failed"))
                .field("error", err)
                .emit();
            return;
        }
        // Keep `watcher` alive by blocking on the channel for the app's lifetime.
        for res in rx.iter() {
            match res {
                Ok(event) if filter(&event) => {
                    let extra = drain_burst(
                        &rx,
                        Instant::now() + WATCH_DEBOUNCE,
                        |r| matches!(r, Ok(ev) if filter(ev)),
                    );
                    match classify(&app) {
                        ChangeOrigin::SelfWrite => {
                            log::debug("watch", format!("{label}: own write, not reloading"))
                                .field("events", extra + 1)
                                .emit();
                        }
                        ChangeOrigin::External => {
                            log::info("watch", format!("{label}: external change"))
                                .field("events", extra + 1)
                                .emit();
                            let _ = app.emit(event_name, ());
                            on_external(&app);
                        }
                    }
                }
                Ok(_) => {}
                Err(err) => log::warn("watch", format!("{label} watch error"))
                    .field("error", err)
                    .emit(),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_burst_coalesces_until_the_deadline() {
        let (tx, rx) = std::sync::mpsc::channel::<u32>();
        tx.send(1).unwrap();
        tx.send(2).unwrap();
        tx.send(u32::MAX).unwrap(); // filtered out
        let started = Instant::now();
        let extra = drain_burst(&rx, started + Duration::from_millis(40), |v| *v != u32::MAX);
        assert_eq!(extra, 2);
        // It waited out the whole window (a late straggler would have been folded in)…
        assert!(started.elapsed() >= Duration::from_millis(40));
        // …and returns promptly when the sender is gone.
        drop(tx);
        let started = Instant::now();
        assert_eq!(
            drain_burst(&rx, started + Duration::from_secs(5), |_| true),
            0
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
