// Guardrail limits for a container's OWN spacing (pad / gap), relative to its solved box. A pad (or
// gap) larger than the box collapses the content to zero — every child solves to zero size, so the
// panes vanish from the canvas and can't be dropped into (you still see them in the tree). These
// caps keep pad/gap within the box so that can't happen, while staying RELATIVE to the box: a
// full-monitor root still allows large pads, a 166×98 widget def does not. Pure; the Inspector
// applies them as <input max> + clamps on edit, and `clampTreeSpacing` heals an existing tree on
// open / split. `undefined` = box unknown (no cap yet). Co-located tests in spacingGuard.test.ts.

import { isContainer, type LayoutNode, type Pad } from './layoutTree';

export type Size = { w: number; h: number };

function smaller(box: Size | null | undefined): number | null {
	if (!box || box.w <= 0 || box.h <= 0) return null;
	return Math.min(box.w, box.h);
}

/** Max per-side padding: a QUARTER of the box's smaller axis, so even a maxed-out pad leaves at
 * least half the box as content — i.e. the panes stay usable (visible, droppable), not collapsed. */
export function maxPad(box: Size | null | undefined): number | undefined {
	const m = smaller(box);
	return m === null ? undefined : Math.max(0, Math.floor(m / 4));
}

/** Max gap; capped at half the box's smaller axis (the solver clamps any residual at render). */
export function maxGap(box: Size | null | undefined): number | undefined {
	const m = smaller(box);
	return m === null ? undefined : Math.max(0, Math.floor(m / 2));
}

/** Clamp a spacing value to [0, max]; non-finite (empty field) → 0. `max` undefined → only floor 0. */
export function clampSpacing(value: number, max: number | undefined): number {
	if (!Number.isFinite(value)) return 0;
	const v = Math.max(0, value);
	return max === undefined ? v : Math.min(v, max);
}

function clampPad(pad: Pad, max: number): Pad {
	if (typeof pad === 'number') return Math.min(pad, max);
	return {
		t: Math.min(pad.t, max),
		r: Math.min(pad.r, max),
		b: Math.min(pad.b, max),
		l: Math.min(pad.l, max)
	};
}

/**
 * Heal an existing subtree: clamp every container's pad/gap to `canvas` (the widget design canvas /
 * def size), so spacing left over from a bigger context (e.g. a pad copied from a full-monitor root)
 * can't collapse a small widget. Returns a NEW tree only where something changed; identical input is
 * returned by reference so it never spuriously dirties the editor. Pure. The canvas size is an upper
 * bound for nested containers (their real box is smaller), so this only ever trims egregious values.
 */
export function clampTreeSpacing(node: LayoutNode, canvas: Size): LayoutNode {
	if (!isContainer(node)) return node;
	const pMax = maxPad(canvas);
	const gMax = maxGap(canvas);
	const children = node.children.map((c) => clampTreeSpacing(c, canvas));
	let changed = children.some((c, i) => c !== node.children[i]);
	const next = { ...node, children };
	if (pMax !== undefined && node.pad !== undefined) {
		const p = clampPad(node.pad, pMax);
		if (JSON.stringify(p) !== JSON.stringify(node.pad)) {
			next.pad = p;
			changed = true;
		}
	}
	if (gMax !== undefined && typeof node.gap === 'number' && node.gap > gMax) {
		next.gap = gMax;
		changed = true;
	}
	return changed ? next : node;
}
