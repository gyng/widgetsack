// Per-widget render profiling for the studio's "widget render cost" diagnostics. Canvas wraps each
// WidgetHost in a React <Profiler> (studio only) that calls recordWidgetRender on every commit; the
// Diagnostics panel polls widgetCosts() to surface churning (re-rendering too often) or slow widgets —
// e.g. a meter that re-renders every tick when nothing changed. Module singleton (the studio is one
// window). No React/Tauri imports — the pure cost math is unit-tested.

type Stat = { commits: number; totalMs: number; lastMs: number; firstTs: number; lastTs: number };

const stats = new Map<string, Stat>();

/** React <Profiler> onRender. Aggregates per-widget commit count + render time. */
export function recordWidgetRender(
	id: string,
	_phase: 'mount' | 'update' | 'nested-update',
	actualDuration: number,
	_baseDuration: number,
	_startTime: number,
	commitTime: number
): void {
	const s = stats.get(id);
	if (s) {
		s.commits += 1;
		s.totalMs += actualDuration;
		s.lastMs = actualDuration;
		s.lastTs = commitTime;
	} else {
		stats.set(id, {
			commits: 1,
			totalMs: actualDuration,
			lastMs: actualDuration,
			firstTs: commitTime,
			lastTs: commitTime
		});
	}
}

export type WidgetCost = {
	id: string;
	type: string;
	commits: number;
	perSec: number;
	avgMs: number;
	lastMs: number;
};

/** Per-widget render cost, busiest first (re-renders/sec, then slowest average). `perSec` counts the
 * commits since the FIRST sighting over their elapsed span, so a single commit reads 0/s (no interval
 * yet). The `type` is the widget-id prefix (`clock-ab12` → `clock`). Pure over the module's accumulator. */
export function widgetCosts(): WidgetCost[] {
	const out: WidgetCost[] = [];
	for (const [id, s] of stats) {
		const spanSec = (s.lastTs - s.firstTs) / 1000;
		const perSec = s.commits > 1 && spanSec > 0 ? (s.commits - 1) / spanSec : 0;
		out.push({
			id,
			type: id.split('-')[0] || id,
			commits: s.commits,
			perSec,
			avgMs: s.totalMs / s.commits,
			lastMs: s.lastMs
		});
	}
	return out.sort((a, b) => b.perSec - a.perSec || b.avgMs - a.avgMs);
}

export function resetWidgetProfile(): void {
	stats.clear();
}
