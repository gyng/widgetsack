// Where a NEW floating widget lands when nothing says where (a palette click, not a drag): the
// first free spot on the stage, so an add is always visible instead of stacking every new widget
// on the same default (24,24) corner under the last one. Pure — the editor model calls it with
// the rects already on the monitor (measured flow + floating) and the stage bounds.
import type { Rect } from './layout';

export type Size = { w: number; h: number };

export type PlacementOptions = {
	/** Editor grid (px): candidate origins snap to it so the widget aligns with everything else. */
	grid?: number;
	/** Inset from the stage edges (px) for the first candidate row/column. */
	margin?: number;
	/** Clearance kept between the new widget and an existing rect (px). */
	gap?: number;
	/** Cascade step (px) when the stage has no free spot at all. */
	cascade?: number;
};

const DEFAULTS: Required<PlacementOptions> = { grid: 8, margin: 24, gap: 8, cascade: 24 };

function overlaps(a: Rect, b: Rect, gap: number): boolean {
	return (
		a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y
	);
}

/**
 * The top-left for a `size` box that fits inside `bounds` without overlapping any of `existing`
 * (keeping `gap` clearance), scanning top-to-bottom then left-to-right over the "corner" candidates
 * (the margin origin, and the right/bottom edge of every existing rect). Snapped to the grid.
 * When nothing fits — the stage is full, or the box is bigger than the stage — falls back to a
 * cascade from the margin origin (+`cascade` px per existing widget, wrapping so it stays on
 * the stage), so repeated adds still fan out instead of piling exactly on top of each other.
 */
export function firstFreeSpot(
	existing: Rect[],
	size: Size,
	bounds: Rect,
	opts: PlacementOptions = {}
): { x: number; y: number } {
	const { grid, margin, gap, cascade } = { ...DEFAULTS, ...opts };
	// Snap UP so a candidate never lands short of the edge it was derived from (a rect's right edge
	// + gap, or the stage margin) — rounding down would re-overlap by up to half a grid step.
	const snap = (n: number) => Math.ceil(n / grid) * grid;
	const x0 = bounds.x + margin;
	const y0 = bounds.y + margin;
	const xMax = bounds.x + bounds.w - margin - size.w;
	const yMax = bounds.y + bounds.h - margin - size.h;
	if (xMax >= x0 && yMax >= y0) {
		const xs = new Set<number>([snap(x0)]);
		const ys = new Set<number>([snap(y0)]);
		for (const r of existing) {
			xs.add(snap(r.x + r.w + gap));
			xs.add(snap(r.x));
			ys.add(snap(r.y + r.h + gap));
			ys.add(snap(r.y));
		}
		const xList = [...xs].filter((x) => x >= x0 && x <= xMax).sort((a, b) => a - b);
		const yList = [...ys].filter((y) => y >= y0 && y <= yMax).sort((a, b) => a - b);
		for (const y of yList) {
			for (const x of xList) {
				const cand = { x, y, w: size.w, h: size.h };
				if (!existing.some((r) => overlaps(cand, r, gap))) return { x, y };
			}
		}
	}
	// Cascade fallback: fan out from the margin origin, one step per widget already there, wrapping
	// before the box would leave the stage (or every step when the box can't fit at all).
	const stepsX = Math.max(1, Math.floor((xMax - x0) / cascade) + 1);
	const stepsY = Math.max(1, Math.floor((yMax - y0) / cascade) + 1);
	const n = existing.length % Math.max(1, Math.min(stepsX, stepsY));
	return { x: snap(x0 + n * cascade), y: snap(y0 + n * cascade) };
}
