import { describe, expect, it } from 'vitest';
import { alignRects, distributeRects, snapRectToPeers } from './align';

const peer = { x: 100, y: 100, w: 50, h: 50 }; // edges x:100,125,150 / y:100,125,150

describe('snapRectToPeers', () => {
	it('snaps a left edge to a peer left edge and reports a guide', () => {
		const r = snapRectToPeers({ x: 96, y: 200, w: 20, h: 20 }, [peer], 6);
		expect(r.rect.x).toBe(100);
		expect(r.guideXs).toEqual([100]);
		expect(r.rect.y).toBe(200); // nothing to snap vertically
		expect(r.guideYs).toEqual([]);
	});

	it('snaps centre-to-centre', () => {
		const r = snapRectToPeers({ x: 113, y: 200, w: 20, h: 20 }, [peer], 6);
		expect(r.rect.x + r.rect.w / 2).toBe(125); // centre aligns to peer centre
		expect(r.guideXs).toEqual([125]);
	});

	it('does not snap when every edge is outside the threshold', () => {
		const r = snapRectToPeers({ x: 160, y: 160, w: 20, h: 20 }, [peer], 6);
		expect(r.rect).toEqual({ x: 160, y: 160, w: 20, h: 20 });
		expect(r.guideXs).toEqual([]);
		expect(r.guideYs).toEqual([]);
	});

	it('picks the closest of several candidate edges', () => {
		// right edge (x+ w = 152) is 2px from peer right (150); left (148) is closer to nothing
		const r = snapRectToPeers({ x: 132, y: 96, w: 20, h: 20 }, [peer], 6);
		expect(r.rect.x + r.rect.w).toBe(150); // right edge snaps to peer right
		expect(r.guideXs).toEqual([150]);
		expect(r.rect.y).toBe(100); // top snaps to peer top
		expect(r.guideYs).toEqual([100]);
	});

	it('returns the rect unchanged with no peers', () => {
		const r = snapRectToPeers({ x: 5, y: 5, w: 10, h: 10 }, [], 6);
		expect(r.rect).toEqual({ x: 5, y: 5, w: 10, h: 10 });
	});
});

describe('alignRects (multi-select align)', () => {
	const a = { id: 'a', rect: { x: 10, y: 10, w: 20, h: 10 } };
	const b = { id: 'b', rect: { x: 50, y: 40, w: 10, h: 30 } };
	const c = { id: 'c', rect: { x: 30, y: 20, w: 40, h: 20 } };

	it('lines edges up with the selection bounding box, keeping sizes', () => {
		expect(alignRects([a, b, c], 'left')).toEqual([
			{ id: 'b', rect: { x: 10, y: 40, w: 10, h: 30 } },
			{ id: 'c', rect: { x: 10, y: 20, w: 40, h: 20 } }
		]);
		// right edge = 70 (c's right); c already sits there → only a and b move
		expect(alignRects([a, b, c], 'right').map((p) => [p.id, p.rect.x])).toEqual([
			['a', 50],
			['b', 60]
		]);
		expect(alignRects([a, b, c], 'top').map((p) => [p.id, p.rect.y])).toEqual([
			['b', 10],
			['c', 10]
		]);
		expect(alignRects([a, b, c], 'bottom').map((p) => [p.id, p.rect.y])).toEqual([
			['a', 60],
			['c', 50]
		]);
	});

	it('centres on the bounding-box midpoint (rounded)', () => {
		// box x 10..70 → mid 40; y 10..70 → mid 40
		expect(alignRects([a, b, c], 'centre').map((p) => [p.id, p.rect.x])).toEqual([
			['a', 30],
			['b', 35],
			['c', 20]
		]);
		expect(alignRects([a, b, c], 'middle').map((p) => [p.id, p.rect.y])).toEqual([
			['a', 35],
			['b', 25],
			['c', 30]
		]);
	});

	it('is a no-op for fewer than two rects', () => {
		expect(alignRects([a], 'left')).toEqual([]);
		expect(alignRects([], 'top')).toEqual([]);
	});
});

describe('distributeRects (multi-select distribute)', () => {
	it('spaces the middle rects evenly between the outer two (order-independent)', () => {
		const items = [
			{ id: 'c', rect: { x: 100, y: 0, w: 20, h: 10 } },
			{ id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } },
			{ id: 'b', rect: { x: 12, y: 0, w: 30, h: 10 } }
		];
		// span 0..120, widths 60 → 2 gaps of 30: b lands at 10+30 = 40
		expect(distributeRects(items, 'horizontal')).toEqual([
			{ id: 'b', rect: { x: 40, y: 0, w: 30, h: 10 } }
		]);
	});

	it('works vertically, rounds, and skips rects already in place', () => {
		const items = [
			{ id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } },
			{ id: 'b', rect: { x: 0, y: 15, w: 10, h: 10 } },
			{ id: 'c', rect: { x: 0, y: 30, w: 10, h: 10 } },
			{ id: 'd', rect: { x: 0, y: 41, w: 10, h: 10 } }
		];
		// span 0..51, heights 40 → gap 11/3 ≈ 3.67: b → 14, c → 27
		expect(distributeRects(items, 'vertical').map((p) => [p.id, p.rect.y])).toEqual([
			['b', 14],
			['c', 27]
		]);
		expect(
			distributeRects(
				[
					{ id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } },
					{ id: 'b', rect: { x: 0, y: 20, w: 10, h: 10 } },
					{ id: 'c', rect: { x: 0, y: 40, w: 10, h: 10 } }
				],
				'vertical'
			)
		).toEqual([]);
	});

	it('needs at least three rects', () => {
		expect(
			distributeRects(
				[
					{ id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } },
					{ id: 'b', rect: { x: 50, y: 0, w: 10, h: 10 } }
				],
				'horizontal'
			)
		).toEqual([]);
	});
});
