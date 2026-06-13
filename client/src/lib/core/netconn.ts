// Pure parsing + shaping for the network-connections widget. No React/DOM — unit-tested. Mirrors the
// `ProcConn` rows the Rust `netconn.rs` emits as the `net.conn.list` JSON sensor (plus the
// `net.conn.{established,listening,public}` scalar totals). The widget is observability, not an IDS:
// it surfaces which process is talking to which PUBLIC remote so a human can notice the unusual one.

/** One process's connection summary — a row of `net.conn.list`. Mirrors Rust `ProcConn` (camelCase). */
export type ProcConn = {
	proc: string;
	pid: number;
	/** Established (active) connections owned by this process. */
	established: number;
	/** Sockets in LISTEN state (accepting inbound). */
	listening: number;
	/** Of `established`, how many go to a PUBLIC (non-private) remote — the "peace of mind" number. */
	public: number;
	/** Distinct public remote `ip:port` endpoints (capped backend-side). */
	remotes: string[];
};

const asNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Defensively parse the `net.conn.list` JSON sensor value into typed rows. Anything malformed is
 * dropped rather than thrown, so a wire hiccup degrades to fewer rows, never a crashed widget. */
export function parseConnList(value: unknown): ProcConn[] {
	if (!Array.isArray(value)) return [];
	const out: ProcConn[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') continue;
		const r = raw as Record<string, unknown>;
		if (typeof r.proc !== 'string') continue;
		out.push({
			proc: r.proc,
			pid: asNum(r.pid),
			established: asNum(r.established),
			listening: asNum(r.listening),
			public: asNum(r.public),
			remotes: Array.isArray(r.remotes)
				? r.remotes.filter((x): x is string => typeof x === 'string')
				: []
		});
	}
	return out;
}

/** Rows to actually display: optionally hide listener-only processes (no established connections),
 * then cap to `max`. Backend already sorts busiest-first, so this just trims. */
export function visibleConns(rows: ProcConn[], showListening: boolean, max: number): ProcConn[] {
	const filtered = showListening ? rows : rows.filter((r) => r.established > 0);
	return filtered.slice(0, Math.max(0, max));
}

/** A one-line risk label for a process row: "public" when it talks to the open Internet (the thing to
 * eyeball), else "local"/"listening"/"idle". Drives the per-row accent. */
export function connLevel(r: ProcConn): 'public' | 'local' | 'listening' | 'idle' {
	if (r.public > 0) return 'public';
	if (r.established > 0) return 'local';
	if (r.listening > 0) return 'listening';
	return 'idle';
}
