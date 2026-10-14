// HA history backfill (outer-ring adapter): when a numeric HA sensor (`ha.<entity>.state`) gains a
// live subscriber, fetch its recent history once and ingest it into THIS window's hub, so a sparkline
// / gauge bound to an HA entity isn't blank on launch. Driven reactively off hub.onActiveChange so it
// fires whenever a widget mounts (no startup timing race), and runs per-window (each overlay backfills
// its own hub). The hub's order-stable ingest (core/telemetry.ts) merges the back-dated samples into
// the right place. The pure id helper is unit-tested; the orchestration is thin I/O.
import type { TelemetryHub } from '../../core/telemetry';
import { haHistory } from './ha-commands';

// How far back to backfill. The hub is count-windowed (caps at its historyLen) and we request
// significant-changes-only, so a wider horizon mainly helps QUIET sensors (which change rarely) have
// at least a few points on launch; chatty sensors stay bounded by the significant-changes filter +
// the hub cap. A day balances "not blank for slow sensors" against payload size.
const HISTORY_HOURS = 24;

/** First retry delay after a failed backfill; doubles per consecutive failure up to the max, so an
 * unconfigured / unreachable HA isn't re-queried (and re-warned) on every active-set change. */
export const HA_BACKFILL_RETRY_MS = 30_000;
export const HA_BACKFILL_MAX_RETRY_MS = 10 * 60_000;

/** The HA entity_id to backfill from a hub sensor id, or null if it isn't a numeric HA history id.
 * Only the scalar `ha.<entity>.state` id has history to fill; the json `ha.<entity>` id (and the
 * `ha.status` connection sensor) are ignored. `ha.sensor.temp.state` → `sensor.temp`. */
export function haEntityForHistory(sensorId: string): string | null {
	const SUFFIX = '.state';
	if (!sensorId.startsWith('ha.') || !sensorId.endsWith(SUFFIX)) return null;
	const entity = sensorId.slice('ha.'.length, -SUFFIX.length);
	// A real entity id is `<domain>.<object_id>` — must contain a dot (rejects e.g. `ha.status`).
	return entity.includes('.') ? entity : null;
}

async function backfillOne(hub: TelemetryHub, entity: string): Promise<boolean> {
	try {
		const end = new Date().toISOString();
		const start = new Date(Date.now() - HISTORY_HOURS * 3600_000).toISOString();
		const samples = await haHistory(entity, start, end);
		if (samples.length) hub.ingestBatch(samples, { historyOnly: true });
		return true;
	} catch (err) {
		console.warn('HA history backfill failed for', entity, err);
		return false;
	}
}

/** Start reactive HA history backfill on `hub`. Each entity is backfilled at most once on success;
 * a failed entity is retried on a later active-change tick, but no sooner than its backoff allows.
 * Returns a stop function (unsubscribes the active-change listener). */
export function startHaBackfill(hub: TelemetryHub): () => void {
	const done = new Set<string>();
	// Per failed entity: earliest retry time and the delay that produced it (doubled on each failure).
	const backoff = new Map<string, { at: number; delay: number }>();
	const run = (): void => {
		for (const id of hub.activeSensorIds()) {
			const entity = haEntityForHistory(id);
			if (!entity || done.has(entity)) continue;
			const wait = backoff.get(entity);
			if (wait && Date.now() < wait.at) continue;
			// Claim it now so concurrent active-change ticks don't double-fetch the same entity, but
			// release it again if the fetch failed (HA blip at mount) so a later tick can retry.
			done.add(entity);
			void backfillOne(hub, entity).then((ok) => {
				if (ok) {
					backoff.delete(entity);
					return;
				}
				done.delete(entity);
				const delay = wait
					? Math.min(wait.delay * 2, HA_BACKFILL_MAX_RETRY_MS)
					: HA_BACKFILL_RETRY_MS;
				backoff.set(entity, { at: Date.now() + delay, delay });
			});
		}
	};
	const off = hub.onActiveChange(run);
	run(); // catch anything already subscribed
	return off;
}
