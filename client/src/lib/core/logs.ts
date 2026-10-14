// Structured backend log entry — mirrors the Rust `LogRecord` / `LogLevel` in widgetsack/src/log.rs
// (AGENTS.md §5: keep both sides of the bridge in sync). Pure types only — the Tauri adapter that
// fetches the backlog / streams new entries lives in the outer ring (lib/logs.ts).

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export type LogRecord = {
	ts_ms: number; // unix epoch millis
	level: LogLevel;
	target: string; // subsystem: 'gsmtc' | 'sensors' | 'ha' | 'watch' | 'clickthrough' | 'bridge' | 'startup' | …
	message: string;
	fields?: Record<string, string>; // structured key/values (omitted when empty)
};

// Ascending severity — handy for "show this level and above" filters in a logs UI.
export const LOG_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

/** True when `level` is at least `min` in severity (e.g. atLeastLevel('warn', 'info') === true). */
export function atLeastLevel(level: LogLevel, min: LogLevel): boolean {
	return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(min);
}

const logKey = (r: LogRecord): string =>
	JSON.stringify([r.ts_ms, r.level, r.target, r.message, r.fields ?? null]);

/** Fold the fetched backlog under records the live stream delivered while the fetch was in flight.
 * The backend buffers before it emits, so a live record is usually also in the backlog (dropped as
 * a duplicate, counting copies so genuinely repeated lines survive) — but one buffered AFTER the
 * snapshot only exists in `live`, and replacing would lose it. Records carry no sequence id, so
 * identity is the whole record. Pure. */
export function mergeLogBacklog(backlog: LogRecord[], live: LogRecord[]): LogRecord[] {
	const inBacklog = new Map<string, number>();
	for (const r of backlog) inBacklog.set(logKey(r), (inBacklog.get(logKey(r)) ?? 0) + 1);
	const merged = [...backlog];
	for (const r of live) {
		const n = inBacklog.get(logKey(r)) ?? 0;
		if (n > 0) inBacklog.set(logKey(r), n - 1);
		else merged.push(r);
	}
	return merged;
}
