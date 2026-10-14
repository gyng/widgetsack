//! Latest-sample cache for the poll-driven peer sources (weather / rss / agenda / stocks). Those
//! workers emit a batch once per fetch (every 15–30 min for some), and their status only on
//! transitions — so a window that mounts in between (studio from the tray, a late secondary overlay,
//! a reload) would stay blank until the next poll. Each worker remembers what it emitted here, and
//! `sensors::set_active_sensors` primes a window from it for the ids it just started consuming —
//! the same shape as `ha::prime_window` / `mqtt::prime_window`.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{Emitter, Runtime};

use crate::sensors::{SensorSample, TELEMETRY_EVENT};

/// Newest sample per sensor id (including the source's `<prefix>.status`).
#[derive(Default)]
pub struct SampleCache {
    latest: Mutex<HashMap<String, SensorSample>>,
}

impl SampleCache {
    /// Remember each sample as its id's newest value.
    pub fn remember(&self, samples: &[SensorSample]) {
        let mut latest = self.latest.lock().unwrap_or_else(|e| e.into_inner());
        for sample in samples {
            latest.insert(sample.sensor.clone(), sample.clone());
        }
    }

    /// Forget everything (a stopped or reconfigured worker's values are no longer current).
    pub fn clear(&self) {
        self.latest
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    /// The cached samples a window that just started wanting `added` should receive.
    pub fn primed(&self, added: &[String]) -> Vec<SensorSample> {
        primed_samples(
            &self.latest.lock().unwrap_or_else(|e| e.into_inner()),
            added,
        )
    }

    /// Whether any cached sensor id satisfies `pred`.
    pub fn any(&self, pred: impl Fn(&str) -> bool) -> bool {
        self.latest
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .any(|id| pred(id))
    }
}

/// The cached samples for `added` (all of them for the studio's `*` wildcard). Pure.
fn primed_samples(cache: &HashMap<String, SensorSample>, added: &[String]) -> Vec<SensorSample> {
    if added.iter().any(|id| id == "*") {
        return cache.values().cloned().collect();
    }
    added
        .iter()
        .filter_map(|id| cache.get(id).cloned())
        .collect()
}

/// Send `window` (alone) the cached value of every id in `added` that `cache` holds.
pub fn prime_window<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    cache: &SampleCache,
    added: &[String],
) {
    if added.is_empty() {
        return;
    }
    let batch = cache.primed(added);
    if !batch.is_empty() {
        let _ = window.emit_to(window.label(), TELEMETRY_EVENT, &batch);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primes_the_newest_value_of_requested_ids_only() {
        let cache = SampleCache::default();
        cache.remember(&[
            SensorSample::text("weather.status", 1, "connecting"),
            SensorSample::scalar("weather.temp", 1, 20.0),
        ]);
        cache.remember(&[
            SensorSample::scalar("weather.temp", 2, 21.5),
            SensorSample::text("weather.status", 2, "connected"),
        ]);
        let primed = cache.primed(&["weather.temp".into(), "weather.status".into()]);
        let v = serde_json::to_value(&primed).unwrap();
        assert_eq!(v[0]["sensor"], "weather.temp");
        assert_eq!(v[0]["ts_ms"], 2);
        assert_eq!(v[1]["sensor"], "weather.status");
        assert_eq!(v[1]["value"]["value"], "connected");
        // Unknown ids prime nothing; the wildcard primes everything cached.
        assert!(cache.primed(&["weather.wind".into()]).is_empty());
        assert_eq!(cache.primed(&["*".into()]).len(), 2);
        assert!(cache.primed(&[]).is_empty());
    }

    #[test]
    fn clear_forgets_and_any_matches_cached_ids() {
        let cache = SampleCache::default();
        cache.remember(&[SensorSample::scalar("stocks.AAPL.price", 1, 1.0)]);
        assert!(cache.any(|id| id.starts_with("stocks.AAPL.")));
        assert!(!cache.any(|id| id.starts_with("stocks.MSFT.")));
        cache.clear();
        assert!(cache.primed(&["*".into()]).is_empty());
        assert!(!cache.any(|_| true));
    }
}
