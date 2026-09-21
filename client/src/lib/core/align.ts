// Pure alignment-snapping geometry for the editor: nudge a dragged rect so its
// edges/centers align with nearby peers, and report the guide lines to draw. No
// Svelte/Tauri; unit-tested.

import type { Rect } from './layout';

export type SnapResult = { rect: Rect; guideXs: number[]; guideYs: number[] };

type Best = { delta: number; guide: number } | null;

function consider(best: Best, target: number, moving: number): Best {
	const delta = target - moving;
	if (best === null || Math.abs(delta) < Math.abs(best.delta)) {
		return { delta, guide: target };
	}
	return best;
}

/**
 * Snap `rect` to `peers` within `threshold` px. Compares the moving rect's left /
 * centre / right against each peer's left / centre / right (and likewise vertically),
 * snapping to the single closest match per axis. Returns the adjusted rect plus the
 * x/y of any guide line to draw. Preserves width/height.
 */
export function snapRectToPeers(rect: Rect, peers: Rect[], threshold: number): SnapResult {
	const { w, h } = rect;
	const movingX = [rect.x, rect.x + w / 2, rect.x + w];
	const movingY = [rect.y, rect.y + h / 2, rect.y + h];

	let bestX: Best = null;
	let bestY: Best = null;

	for (const p of peers) {
		const peerX = [p.x, p.x + p.w / 2, p.x + p.w];
		const peerY = [p.y, p.y + p.h / 2, p.y + p.h];
		for (const m of movingX) {
			for (const t of peerX) {
				if (Math.abs(t - m) <= threshold) bestX = consider(bestX, t, m);
			}
		}
		for (const m of movingY) {
			for (const t of peerY) {
				if (Math.abs(t - m) <= threshold) bestY = consider(bestY, t, m);
			}
		}
	}

	let { x, y } = rect;
	const guideXs: number[] = [];
	const guideYs: number[] = [];
	if (bestX) {
		x += bestX.delta;
		guideXs.push(bestX.guide);
	}
	if (bestY) {
		y += bestY.delta;
		guideYs.push(bestY.guide);
	}

	return { rect: { x, y, w, h }, guideXs, guideYs };
}

// --- Align / distribute a set of floating widgets (the multi-select Inspector + context menu). ---

export type AlignEdge = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';
export type DistributeAxis = 'horizontal' | 'vertical';
export type Placed = { id: string; rect: Rect };

/**
 * Move every rect so the chosen edge/centre lines up with the selection's bounding box (left/top =
 * the outermost left/top, right/bottom = the outermost right/bottom, centre/middle = the box's
 * midpoint). Sizes are preserved; the result only lists the rects that actually moved.
 */
export function alignRects(items: Placed[], edge: AlignEdge): Placed[] {
	if (items.length < 2) return [];
	const left = Math.min(...items.map((i) => i.rect.x));
	const right = Math.max(...items.map((i) => i.rect.x + i.rect.w));
	const top = Math.min(...items.map((i) => i.rect.y));
	const bottom = Math.max(...items.map((i) => i.rect.y + i.rect.h));
	const out: Placed[] = [];
	for (const it of items) {
		const r = it.rect;
		let x = r.x;
		let y = r.y;
		switch (edge) {
			case 'left':
				x = left;
				break;
			case 'centre':
				x = Math.round((left + right) / 2 - r.w / 2);
				break;
			case 'right':
				x = right - r.w;
				break;
			case 'top':
				y = top;
				break;
			case 'middle':
				y = Math.round((top + bottom) / 2 - r.h / 2);
				break;
			case 'bottom':
				y = bottom - r.h;
				break;
		}
		if (x !== r.x || y !== r.y) out.push({ id: it.id, rect: { ...r, x, y } });
	}
	return out;
}

/**
 * Space the rects evenly along one axis: the outermost two stay put and the ones between are
 * repositioned so every gap is equal (a negative gap when they overlap). Needs 3+ rects; sizes are
 * preserved and only moved rects are returned.
 */
export function distributeRects(items: Placed[], axis: DistributeAxis): Placed[] {
	if (items.length < 3) return [];
	const h = axis === 'horizontal';
	const pos = (r: Rect) => (h ? r.x : r.y);
	const size = (r: Rect) => (h ? r.w : r.h);
	const sorted = [...items].sort((a, b) => pos(a.rect) - pos(b.rect));
	const first = sorted[0].rect;
	const last = sorted[sorted.length - 1].rect;
	const span = pos(last) + size(last) - pos(first);
	const total = sorted.reduce((acc, it) => acc + size(it.rect), 0);
	const gap = (span - total) / (sorted.length - 1);
	const out: Placed[] = [];
	let cursor = pos(first) + size(first) + gap;
	for (const it of sorted.slice(1, -1)) {
		const next = Math.round(cursor);
		if (next !== pos(it.rect))
			out.push({ id: it.id, rect: h ? { ...it.rect, x: next } : { ...it.rect, y: next } });
		cursor += size(it.rect) + gap;
	}
	return out;
}
