// Pure sparkline geometry, extracted so it is unit-testable without SVG
// (AGENTS.md §4).

export type Point = [number, number];

/** Resolve the value range, falling back to data bounds where min/max aren't pinned. */
export function sparklineRange(
	history: number[],
	min: number | null,
	max: number | null
): [number, number] {
	const lo = min ?? Math.min(...history);
	const hi = max ?? Math.max(...history);
	return [lo, hi];
}

export type Bar = { x: number; y: number; w: number; h: number };

/** Map a history buffer to histogram bars rising from the baseline. Unlike the line (which
 * scales between the data min and max), bars rise from `min ?? 0` so heights read absolutely;
 * `gap` (0..1) is the fractional spacing between bars.
 *
 * `window > 0` fixes the x-axis to that many slots and RIGHT-ANCHORS the data: the newest sample
 * sits at the rightmost slot and earlier (not-yet-recorded) slots are simply omitted — the chart
 * fills in from the right as history accumulates instead of stretching a few samples full width.
 * `window = 0` keeps the legacy behaviour (one slot per sample). `scroll` shifts the viewport
 * left by a fraction of one sample slot without changing any recorded heights. */
export function sparklineBars(
	history: number[],
	width: number,
	height: number,
	min: number | null = null,
	max: number | null = null,
	gap = 0.2,
	window = 0,
	scroll = 0,
	delay = 0
): Bar[] {
	if (history.length === 0) return [];
	const recent =
		window > 0 ? history.slice(-(window + (delay > 0 ? Math.ceil(delay) + 1 : 0))) : history;
	const lo = min ?? 0;
	const hi = max ?? Math.max(...recent);
	const span = hi - lo || 1;
	const slots = window > 0 ? window : recent.length;
	const offset = slots - recent.length; // blank slots on the left (no data yet)
	const slot = width / slots;
	const shift = (Math.max(-1, Math.min(1, scroll)) - (delay > 0 ? delay + 0.5 : 0)) * slot;
	const w = slot * (1 - gap);
	return recent.map((v, i) => {
		const frac = Math.max(0, Math.min(1, (v - lo) / span));
		const barH = frac * height;
		return { x: (offset + i) * slot + (slot - w) / 2 - shift, y: height - barH, w, h: barH };
	});
}

/** Map a history buffer to points within [0,width] × [0,height] (y inverted). `window` behaves as
 * in sparklineBars: > 0 right-anchors the data in a fixed number of slots (points start partway
 * across until history fills the window); 0 stretches all samples edge-to-edge (legacy). */
export function sparklinePoints(
	history: number[],
	width: number,
	height: number,
	min: number | null = null,
	max: number | null = null,
	window = 0,
	scroll = 0,
	delay = 0
): Point[] {
	if (history.length === 0) return [];
	if (window > 0) {
		const recent = history.slice(-(window + (delay > 0 ? Math.ceil(delay) + 1 : 0)));
		const [lo, hi] = sparklineRange(recent, min, max);
		const span = hi - lo;
		const slot = width / window;
		const shift = (Math.max(-1, Math.min(1, scroll)) - (delay > 0 ? delay + 0.5 : 0)) * slot;
		const offset = window - recent.length;
		return recent.map((v, i) => {
			const frac = span === 0 ? 0.5 : (v - lo) / span;
			return [(offset + i) * slot + slot / 2 - shift, height - frac * height];
		});
	}
	const [lo, hi] = sparklineRange(history, min, max);
	const span = hi - lo;
	const stepX = history.length > 1 ? width / (history.length - 1) : 0;
	return history.map((v, i) => {
		const frac = span === 0 ? 0.5 : (v - lo) / span;
		return [i * stepX, height - frac * height];
	});
}
