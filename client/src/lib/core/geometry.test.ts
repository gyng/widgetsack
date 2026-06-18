import { describe, expect, it } from 'vitest';
import { moveRect, rectsIntersect, resizeRect, snap } from './geometry';
import type { Rect } from './layout';

describe('snap', () => {
	it('snaps to a grid', () => {
		expect(snap(13, 8)).toBe(16);
		expect(snap(11, 8)).toBe(8);
		expect(snap(20, 8)).toBe(24);
	});

	it('rounds to integers when grid <= 1', () => {
		expect(snap(13.6, 1)).toBe(14);
		expect(snap(13.2, 1)).toBe(13);
	});
});

describe('moveRect', () => {
	it('translates the origin and preserves size', () => {
		expect(moveRect({ x: 10, y: 10, w: 50, h: 40 }, 5, 7, 1)).toEqual({
			x: 15,
			y: 17,
			w: 50,
			h: 40
		});
	});

	it('snaps the translated origin to the grid', () => {
		expect(moveRect({ x: 10, y: 10, w: 50, h: 40 }, 3, 3, 8)).toEqual({
			x: 16,
			y: 16,
			w: 50,
			h: 40
		});
	});
});

describe('resizeRect', () => {
	const r = { x: 10, y: 10, w: 50, h: 40 };

	it('grows from the east/south edges', () => {
		expect(resizeRect(r, 'se', 5, 7, 1)).toEqual({ x: 10, y: 10, w: 55, h: 47 });
	});

	it('moves the west/north edges inward', () => {
		expect(resizeRect(r, 'nw', 5, 5, 1)).toEqual({ x: 15, y: 15, w: 45, h: 35 });
	});

	it('clamps to the minimum size, keeping the opposite edge fixed', () => {
		expect(resizeRect(r, 'e', -100, 0, 1, 16)).toEqual({ x: 10, y: 10, w: 16, h: 40 });
		expect(resizeRect(r, 'w', 100, 0, 1, 16)).toEqual({ x: 44, y: 10, w: 16, h: 40 });
	});

	it('clamps the minimum HEIGHT too, keeping the opposite edge fixed', () => {
		// south edge dragged up past the minimum: height pins to min, top unchanged
		expect(resizeRect(r, 's', 0, -100, 1, 16)).toEqual({ x: 10, y: 10, w: 50, h: 16 });
		// north edge dragged down past the minimum: top moves so the south edge stays fixed
		expect(resizeRect(r, 'n', 0, 100, 1, 16)).toEqual({ x: 10, y: 34, w: 50, h: 16 });
	});

	it('snaps only the moved edge to the grid', () => {
		expect(resizeRect(r, 'e', 3, 0, 8)).toEqual({ x: 10, y: 10, w: 54, h: 40 });
	});
});

describe('rectsIntersect', () => {
	const base: Rect = { x: 10, y: 10, w: 20, h: 20 }; // covers 10..30 on both axes

	it('is true for partially overlapping rects', () => {
		expect(rectsIntersect(base, { x: 20, y: 20, w: 20, h: 20 })).toBe(true);
	});

	it('is true when one rect fully contains the other', () => {
		expect(rectsIntersect(base, { x: 0, y: 0, w: 100, h: 100 })).toBe(true);
	});

	it('is false for disjoint rects', () => {
		expect(rectsIntersect(base, { x: 40, y: 40, w: 5, h: 5 })).toBe(false);
	});

	it('is false when edges only touch (no area overlap)', () => {
		// right edge of `base` (x=30) meets the left edge of this rect (x=30)
		expect(rectsIntersect(base, { x: 30, y: 10, w: 10, h: 10 })).toBe(false);
	});

	it('is symmetric', () => {
		const other: Rect = { x: 25, y: 25, w: 50, h: 50 };
		expect(rectsIntersect(base, other)).toBe(rectsIntersect(other, base));
	});
});
