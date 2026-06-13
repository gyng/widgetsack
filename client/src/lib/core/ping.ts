// Pure helpers for the Ping ("is my internet up?") widget. No React/DOM — unit-tested. The backend
// (widgetsack/src/ping.rs) ICMP-pings the host named by the widget's sensor ids and emits
// `net.ping.<host>.ms` (round-trip ms) + `net.ping.<host>.up` (1/0). The meta's `sensors` map binds
// them from config.host; the meter classifies the result with `pingLevel`.

export type PingSensors = { ms: string; up: string };

/** The `{ ms, up }` sensor-id map for a host — what WidgetHost subscribes to (and what tells the
 * backend poller WHICH host to ping, via the active-sensor demand gate). Empty/blank host → 1.1.1.1. */
export function pingSensors(host: string): PingSensors {
	const h = (host ?? '').trim() || '1.1.1.1';
	return { ms: `net.ping.${h}.ms`, up: `net.ping.${h}.up` };
}

export type PingLevel = 'up' | 'slow' | 'down' | 'unknown';

/** Classify a ping result for the UI accent: `unknown` before the first sample, `down` when up≤0,
 * `slow` when the latency is at/above `slowMs`, else `up`. Pure. */
export function pingLevel(up: number | null, ms: number | null, slowMs = 150): PingLevel {
	if (up == null) return 'unknown';
	if (up <= 0) return 'down';
	if (ms != null && ms >= slowMs) return 'slow';
	return 'up';
}
