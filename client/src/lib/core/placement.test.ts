import { describe, expect, it } from 'vitest';
import { firstFreeSpot } from './placement';

const stage = { x: 0, y: 0, w: 1920, h: 1080 };
const size = { w: 120, h: 80 };

describe('firstFreeSpot', () => {
	it('lands at the margin origin on an empty stage', () => {
		expect(firstFreeSpot([], size, stage)).toEqual({ x: 24, y: 24 });
	});

	it('steps to the right of a widget already at the origin (with the gap)', () => {
		const at = firstFreeSpot([{ x: 24, y: 24, w: 120, h: 80 }], size, stage);
		expect(at).toEqual({ x: 152, y: 24 }); // 24 + 120 + 8
	});

	it('scans top-to-bottom before left-to-right (first free ROW wins)', () => {
		// A full-width band at the top: nothing fits beside it, so the next row down is the answer.
		const band = { x: 24, y: 24, w: 1872, h: 40 };
		expect(firstFreeSpot([band], size, stage)).toEqual({ x: 24, y: 72 }); // 24 + 40 + 8
	});

	it('honours the stage origin and snaps candidates to the grid', () => {
		const off = { x: 100, y: 50, w: 800, h: 600 };
		// 100+24=124 → 128, 50+24=74 → 80: snapped UP onto the 8-grid (never short of the margin).
		expect(firstFreeSpot([], size, off)).toEqual({ x: 128, y: 80 });
		const near = firstFreeSpot([{ x: 128, y: 80, w: 101, h: 80 }], size, off);
		expect(near).toEqual({ x: 240, y: 80 }); // 128+101+8=237 → 240
	});

	it('never returns a spot that overlaps an existing rect', () => {
		const existing = [
			{ x: 24, y: 24, w: 300, h: 300 },
			{ x: 332, y: 24, w: 300, h: 300 },
			{ x: 24, y: 332, w: 300, h: 300 }
		];
		const at = firstFreeSpot(existing, size, stage);
		const cand = { ...at, ...size };
		for (const r of existing) {
			const hit =
				cand.x < r.x + r.w && cand.x + cand.w > r.x && cand.y < r.y + r.h && cand.y + cand.h > r.y;
			expect(hit).toBe(false);
		}
	});

	it('cascades +24px per existing widget when the stage has no free spot', () => {
		const small = { x: 0, y: 0, w: 400, h: 400 };
		const full = { x: 0, y: 0, w: 400, h: 400 }; // one widget covering the whole stage
		expect(firstFreeSpot([full], size, small)).toEqual({ x: 48, y: 48 });
		expect(firstFreeSpot([full, full], size, small)).toEqual({ x: 72, y: 72 });
	});

	it('cascade wraps so the box stays on the stage', () => {
		const small = { x: 0, y: 0, w: 200, h: 200 };
		const blocker = { x: 0, y: 0, w: 200, h: 200 };
		// x0=24, xMax=56 → 2 steps (24, 48) before wrapping.
		expect(firstFreeSpot([blocker], size, small)).toEqual({ x: 48, y: 48 });
		expect(firstFreeSpot([blocker, blocker], size, small)).toEqual({ x: 24, y: 24 });
		expect(firstFreeSpot([blocker, blocker, blocker], size, small)).toEqual({ x: 48, y: 48 });
	});

	it('a box bigger than the stage falls straight to the cascade origin', () => {
		expect(firstFreeSpot([], { w: 500, h: 500 }, { x: 0, y: 0, w: 300, h: 300 })).toEqual({
			x: 24,
			y: 24
		});
	});
});
