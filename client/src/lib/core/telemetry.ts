// Framework-agnostic telemetry core. No Svelte and no Tauri imports — this is the
// inner domain ring (AGENTS.md §5) and is meant to be reused verbatim by a future
// React port. Mirrors the Rust `SensorValue` / `SensorSample` in np/src/sensors.rs
// (snake_case across the bridge — keep both sides in sync).

export type SensorValue =
	| { kind: 'scalar'; value: number }
	| { kind: 'text'; value: string }
	| { kind: 'series'; value: number[] }
	| { kind: 'json'; value: unknown };

export type SensorSample = { sensor: string; ts_ms: number; value: SensorValue };
export type TelemetryBatch = SensorSample[];

// `historyTs` runs parallel to `history` (same length): the ts_ms of each retained sample, kept so
// ingest can stay ORDER-STABLE BY TIME. It's optional so existing `{ value, history }` literals (and
// older snapshots) still type-check; when absent it's treated as empty / zero-filled. Consumers that
// only chart values read `history` and can ignore it.
export type SensorState = { value: SensorValue | null; history: number[]; historyTs?: number[] };

// A single frozen empty state, shared so `getSnapshot()` is referentially stable
// before any sample arrives (required for React's useSyncExternalStore).
const EMPTY: SensorState = Object.freeze({
	value: null,
	history: [],
	historyTs: []
}) as SensorState;

export const emptySensorState = (): SensorState => ({ value: null, history: [], historyTs: [] });

/** The numeric component of a sample for history/sparklines, or null if non-numeric. */
function numericOf(value: SensorValue): number | null {
	if (value.kind === 'scalar') return value.value;
	if (value.kind === 'series') return value.value.at(-1) ?? null;
	return null;
}

/** Pure reducer: apply a sample to a sensor's state, capping history at `historyLen`. Keeps the
 * series ORDER-STABLE BY `ts_ms` so back-dated samples (history backfill) merge into the right place
 * instead of being appended out of order. The common live case (ts ≥ the last sample) is a plain
 * append; only an earlier ts triggers an insertion-sort, so steady-state ingest stays O(1). */
export function appendSample(
	state: SensorState,
	sample: SensorSample,
	historyLen: number
): SensorState {
	// Keep ts in lockstep with history length even for legacy states that lacked it (zero-fill = oldest).
	const ts0 =
		state.historyTs && state.historyTs.length === state.history.length
			? state.historyTs
			: state.history.map(() => 0);
	const n = numericOf(sample.value);
	if (n === null) return { value: sample.value, history: state.history, historyTs: ts0 };
	if (historyLen <= 0) return { value: sample.value, history: [], historyTs: [] };

	const ts = sample.ts_ms;
	let history: number[];
	let historyTs: number[];
	if (ts0.length === 0 || ts >= ts0[ts0.length - 1]) {
		history = [...state.history, n];
		historyTs = [...ts0, ts];
	} else {
		// First index whose ts is greater than this sample's → insert before it (after equal ts, stable).
		let i = ts0.length;
		while (i > 0 && ts0[i - 1] > ts) i--;
		history = [...state.history.slice(0, i), n, ...state.history.slice(i)];
		historyTs = [...ts0.slice(0, i), ts, ...ts0.slice(i)];
	}
	if (history.length > historyLen) {
		history = history.slice(-historyLen);
		historyTs = historyTs.slice(-historyLen);
	}
	return { value: sample.value, history, historyTs };
}

/** Base backend sampling cadence (sensors.rs INTERVAL_MS). Self-discovering meters treat an id
 * silent for ~3 ticks as gone (an ejected drive, a removed core) — see `sensorIds({ freshWithinMs })`. */
export const BASE_INTERVAL_MS = 1000;
export const STALE_AFTER_MS = 3 * BASE_INTERVAL_MS;

/** Options for `TelemetryHub.sensorIds`: `freshWithinMs` keeps only ids whose newest sample is
 * within that many ms of the hub's NEWEST sample overall (the hub's own clock, so a paused backend
 * or clock skew never empties the list — only an id that stopped while others kept ticking ages out). */
export type SensorIdsOptions = { freshWithinMs?: number };

/** A minimal notify-based observable — consumable by Svelte stores and React alike. */
export interface SensorObservable {
	subscribe(cb: () => void): () => void;
	getSnapshot(): SensorState;
}

export interface TelemetryHub {
	ingest(sample: SensorSample): void;
	ingestBatch(batch: TelemetryBatch): void;
	sensor(id: string): SensorObservable;
	/** Ids of sensors seen so far (i.e. that have emitted at least one sample); with `freshWithinMs`,
	 * only those still ticking (see SensorIdsOptions). */
	sensorIds(opts?: SensorIdsOptions): string[];
	/** The `ts_ms` of the newest sample seen for `id` (any kind — text/json too), or null if none. */
	lastSeen(id: string): number | null;
	/** Ids that currently have ≥1 live UI subscriber (demand-gating, AGENTS.md #9). */
	activeSensorIds(): string[];
	/** Fire `cb` whenever the active set changes (a sensor goes 0→1 or 1→0 listeners). */
	onActiveChange(cb: () => void): () => void;
}

/** Create a hub that routes samples to per-sensor state and notifies subscribers. `historyLen`
 * is the shared ring-buffer cap (≈ seconds at the 1s base cadence); the default holds 10 minutes
 * so each sparkline can pick a shorter window (default 1 min) and still have data to anchor. */
export function createTelemetryHub(historyLen = 600): TelemetryHub {
	const states = new Map<string, SensorState>();
	// Newest ts_ms per id, for staleness checks. Kept apart from `historyTs` (numeric samples only,
	// capped) so text/json sensors age the same way; `Math.max` so a back-dated backfill can't rewind it.
	const lastTs = new Map<string, number>();
	let newestTs = -Infinity;
	const listeners = new Map<string, Set<() => void>>();
	// Callbacks notified when the active (subscribed) set transitions, not on every sample.
	const activeListeners = new Set<() => void>();

	const stateOf = (id: string): SensorState => states.get(id) ?? EMPTY;

	const notifyActive = (): void => {
		activeListeners.forEach((cb) => cb());
	};

	const ingest = (sample: SensorSample): void => {
		states.set(sample.sensor, appendSample(stateOf(sample.sensor), sample, historyLen));
		const ts = Math.max(sample.ts_ms, lastTs.get(sample.sensor) ?? -Infinity);
		lastTs.set(sample.sensor, ts);
		if (ts > newestTs) newestTs = ts;
		listeners.get(sample.sensor)?.forEach((cb) => cb());
	};

	return {
		ingest,
		ingestBatch: (batch) => batch.forEach(ingest),
		sensorIds: (opts) => {
			const fresh = opts?.freshWithinMs;
			if (fresh === undefined) return Array.from(states.keys());
			// `lastTs` holds exactly the ids of `states` (both are written by ingest), in the same order.
			const cutoff = newestTs - fresh;
			return Array.from(lastTs.entries())
				.filter(([, ts]) => ts >= cutoff)
				.map(([id]) => id);
		},
		lastSeen: (id) => lastTs.get(id) ?? null,
		activeSensorIds: () =>
			Array.from(listeners.entries())
				.filter(([, set]) => set.size > 0)
				.map(([id]) => id),
		onActiveChange(cb) {
			activeListeners.add(cb);
			return () => {
				activeListeners.delete(cb);
			};
		},
		sensor: (id) => ({
			subscribe(cb) {
				let set = listeners.get(id);
				if (!set) {
					set = new Set();
					listeners.set(id, set);
				}
				const wasEmpty = set.size === 0;
				set.add(cb);
				if (wasEmpty) notifyActive();
				return () => {
					if (!set?.delete(cb)) return;
					if (set.size === 0) notifyActive();
				};
			},
			getSnapshot: () => stateOf(id)
		})
	};
}
