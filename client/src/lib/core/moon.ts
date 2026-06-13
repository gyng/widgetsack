// Pure sun/moon helpers for the Sun/Moon widget. No React/DOM — unit-tested. Sunrise/sunset come from
// the weather source (weather.sun.{rise,set}, location-local ISO strings); the moon phase is computed
// here from the wall clock (no backend needed) via the synodic-month cycle.

const SYNODIC_DAYS = 29.530588853; // mean length of a lunar cycle (new → new)
const DAY_MS = 86_400_000;
// A reference new moon: 2000-01-06 18:14 UTC (a well-known epoch for phase math).
const REF_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);

/** The moon's phase at `nowMs` as a 0..1 fraction of the synodic month: 0 (and 1) = new, 0.5 = full,
 * 0.25 = first quarter, 0.75 = last quarter. Pure. */
export function moonPhase(nowMs: number): number {
	const days = (nowMs - REF_NEW_MOON_MS) / DAY_MS;
	const frac = (((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS) / SYNODIC_DAYS;
	return frac;
}

export type MoonInfo = { name: string; icon: string; illumination: number };

const PHASES: { name: string; icon: string }[] = [
	{ name: 'New', icon: '🌑' },
	{ name: 'Waxing crescent', icon: '🌒' },
	{ name: 'First quarter', icon: '🌓' },
	{ name: 'Waxing gibbous', icon: '🌔' },
	{ name: 'Full', icon: '🌕' },
	{ name: 'Waning gibbous', icon: '🌖' },
	{ name: 'Last quarter', icon: '🌗' },
	{ name: 'Waning crescent', icon: '🌘' }
];

/** Name + glyph + illuminated fraction (0..1) for a 0..1 phase. Illumination follows
 * (1 − cos(2π·phase))/2 — 0 at new, 1 at full. Pure. */
export function moonInfo(phase: number): MoonInfo {
	const idx = Math.round(phase * 8) % 8;
	const illumination = (1 - Math.cos(2 * Math.PI * phase)) / 2;
	return { ...PHASES[idx], illumination };
}

/** Slice the "HH:mm" wall-clock time out of an Open-Meteo ISO string ("2026-06-14T05:12"). null for
 * empty / non-ISO input. Pure — no Date parse, so it stays in the location's own timezone. */
export function sunTime(iso: string | null): string | null {
	if (!iso) return null;
	const t = iso.indexOf('T');
	if (t < 0 || iso.length < t + 6) return null;
	return iso.slice(t + 1, t + 6);
}
