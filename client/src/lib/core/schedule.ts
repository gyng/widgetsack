// Pure scheduling helpers for the AI widget — an interval ("30s", "5m", "2h") OR a 5-field cron
// expression. No I/O and no clock of its own: the widget's hook drives the clock and asks these
// functions "is it time?". Inner ring (AGENTS.md §5), fully unit-tested.

/** Parse an interval string to milliseconds, or null if it isn't a simple interval (e.g. a cron
 * expression or "manual"). Accepts a bare number (seconds) or a unit suffix ms|s|m|h|d. */
export function intervalMs(s: string): number | null {
	const t = s.trim().toLowerCase();
	if (!t || t === 'manual') return null;
	const m = t.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
	if (!m) return null;
	const n = parseFloat(m[1]);
	const unit = m[2] ?? 's';
	const mult =
		unit === 'ms'
			? 1
			: unit === 's'
				? 1000
				: unit === 'm'
					? 60_000
					: unit === 'h'
						? 3_600_000
						: 86_400_000;
	const ms = n * mult;
	return ms > 0 ? ms : null;
}

/** Whether `s` is shaped like a 5-field cron expression (minute hour day-of-month month day-of-week). */
export function isCron(s: string): boolean {
	return s.trim().split(/\s+/).length === 5 && intervalMs(s) === null;
}

// Match ONE cron field against a value in [min,max]. Supports: '*', a number, a list 'a,b,c', a range
// 'a-b', and a step 'range/n' (including '*' + '/n', e.g. every 15th minute). Other forms -> no match.
function fieldMatches(field: string, value: number, min: number, max: number): boolean {
	return field.split(',').some((partRaw) => {
		const part = partRaw.trim();
		let step = 1;
		let range = part;
		const slash = part.indexOf('/');
		if (slash >= 0) {
			step = parseInt(part.slice(slash + 1), 10) || 1;
			range = part.slice(0, slash);
		}
		let lo = min;
		let hi = max;
		if (range !== '*') {
			const dash = range.indexOf('-');
			if (dash >= 0) {
				lo = parseInt(range.slice(0, dash), 10);
				hi = parseInt(range.slice(dash + 1), 10);
			} else {
				lo = parseInt(range, 10);
				// A bare start WITH a step ("5/15") means "5..max step 15" (standard cron); a bare value
				// with no step ("5") matches only itself.
				hi = slash >= 0 ? max : lo;
			}
			if (Number.isNaN(lo) || Number.isNaN(hi)) return false;
		}
		if (value < lo || value > hi) return false;
		return (value - lo) % step === 0;
	});
}

/** Whether `expr` (a 5-field cron) matches `date`. Day-of-month and day-of-week follow standard cron
 * OR-semantics: if BOTH are restricted (neither is `*`), a match on EITHER counts; otherwise both must
 * match. Returns false for a malformed expression. */
export function cronMatches(expr: string, date: Date): boolean {
	const f = expr.trim().split(/\s+/);
	if (f.length !== 5) return false;
	const [min, hour, dom, mon, dow] = f;
	const minOk = fieldMatches(min, date.getMinutes(), 0, 59);
	const hourOk = fieldMatches(hour, date.getHours(), 0, 23);
	const monOk = fieldMatches(mon, date.getMonth() + 1, 1, 12);
	const domOk = fieldMatches(dom, date.getDate(), 1, 31);
	// getDay() is 0..6 (0=Sunday); standard cron ALSO accepts 7 as Sunday, so match the day against
	// [0,7] and, on Sunday, additionally against 7 (covers "7" and ranges like "6-7").
	const day = date.getDay();
	const dowOk = fieldMatches(dow, day, 0, 7) || (day === 0 && fieldMatches(dow, 7, 0, 7));
	const dayOk = dom !== '*' && dow !== '*' ? domOk || dowOk : domOk && dowOk;
	return minOk && hourOk && monOk && dayOk;
}

/** Validate a schedule string for the settings UI: it must be "manual"/blank, a valid interval, or a
 * valid cron expression. Returns a short human label, or null if invalid. */
export function describeSchedule(s: string): string | null {
	const t = s.trim();
	if (!t || t.toLowerCase() === 'manual') return 'manual only';
	const ms = intervalMs(t);
	if (ms !== null) return `every ${Math.round(ms / 1000)}s`;
	if (isCron(t)) return `cron: ${t}`;
	return null;
}
