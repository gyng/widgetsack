// Pure logic for the Countdown widget. No React/DOM — unit-tested. Distinct from the manual Timer
// widget: this counts down to a TARGET DATE (a "days until X" view) or runs an auto-cycling Pomodoro
// rhythm, both driven purely by the wall clock (the meter just ticks and re-reads). Times in ms.

export type CountdownFormat = 'auto' | 'dhms' | 'hms' | 'ms';

/** Split a non-negative ms duration into day/hour/minute/second parts. */
export function durationParts(ms: number): { d: number; h: number; m: number; s: number } {
	const t = Math.max(0, Math.floor(ms / 1000));
	return {
		d: Math.floor(t / 86400),
		h: Math.floor((t % 86400) / 3600),
		m: Math.floor((t % 3600) / 60),
		s: t % 60
	};
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Format a duration (ms) for display. `auto` shows only the units that matter (days only when > 0,
 * etc.); the fixed formats always show their full shape. Negative durations get a leading "-". */
export function formatCountdown(ms: number, format: CountdownFormat = 'auto'): string {
	const neg = ms < 0;
	const { d, h, m, s } = durationParts(Math.abs(ms));
	let out: string;
	switch (format) {
		case 'dhms':
			out = `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
			break;
		case 'hms':
			out = `${pad(h + d * 24)}:${pad(m)}:${pad(s)}`;
			break;
		case 'ms':
			out = `${pad(m + (h + d * 24) * 60)}:${pad(s)}`;
			break;
		case 'auto':
		default:
			if (d > 0) out = `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
			else if (h > 0) out = `${h}:${pad(m)}:${pad(s)}`;
			else out = `${m}:${pad(s)}`;
			break;
	}
	return neg ? `-${out}` : out;
}

/** Parse a target datetime string (anything `Date` accepts, e.g. "2026-12-31" or "2026-12-31T18:00")
 * to epoch ms, or null when empty/unparseable. */
export function parseTarget(target: string): number | null {
	if (!target || !target.trim()) return null;
	const ms = new Date(target).getTime();
	return Number.isNaN(ms) ? null : ms;
}

export type PomodoroPhase = 'work' | 'break';
export type PomodoroState = { phase: PomodoroPhase; remainingMs: number; cycle: number };

/** Where in a repeating work→break cycle does `elapsedMs` (since the rhythm started) land? Returns the
 * current phase, the ms left in it, and the 1-based work-session number. Pure (no clock read). */
export function pomodoroAt(elapsedMs: number, workMs: number, breakMs: number): PomodoroState {
	const period = Math.max(1, workMs + breakMs);
	const e = Math.max(0, elapsedMs);
	const cycle = Math.floor(e / period) + 1;
	const within = e % period;
	return within < workMs
		? { phase: 'work', remainingMs: workMs - within, cycle }
		: { phase: 'break', remainingMs: period - within, cycle };
}
