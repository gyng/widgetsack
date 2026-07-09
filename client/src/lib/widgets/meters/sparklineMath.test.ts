import { describe, expect, it } from 'vitest';
import { sparklineBars, sparklinePoints, sparklineRange } from './sparklineMath';

describe('sparklineRange', () => {
	it('uses data bounds when min/max are not pinned', () => {
		expect(sparklineRange([2, 5, 1], null, null)).toEqual([1, 5]);
	});

	it('honours pinned bounds', () => {
		expect(sparklineRange([2, 5, 1], 0, 100)).toEqual([0, 100]);
	});
});

describe('sparklinePoints', () => {
	it('maps values across the width with inverted y', () => {
		expect(sparklinePoints([0, 50, 100], 100, 10, 0, 100)).toEqual([
			[0, 10],
			[50, 5],
			[100, 0]
		]);
	});

	it('returns empty for empty history', () => {
		expect(sparklinePoints([], 100, 10)).toEqual([]);
	});

	it('centres a flat series', () => {
		expect(sparklinePoints([5, 5], 100, 10)).toEqual([
			[0, 5],
			[100, 5]
		]);
	});

	it('right-anchors within a fixed window, leaving early time blank', () => {
		// window 4, 2 samples → they occupy slots 2 and 3 (the right half); slots 0–1 stay empty.
		expect(sparklinePoints([10, 20], 100, 10, 0, 20, 4)).toEqual([
			[62.5, 5], // slot 2 centre (2*25 + 12.5), 10/20 → mid height
			[87.5, 0] // slot 3 centre, 20/20 → top
		]);
	});

	it('centres a flat series within a fixed window (pinned min === max → span 0)', () => {
		expect(sparklinePoints([5, 5], 100, 10, 5, 5, 4)).toEqual([
			[62.5, 5],
			[87.5, 5]
		]);
	});

	it('places a single point at x=0 with no window (stepX 0, one sample)', () => {
		expect(sparklinePoints([5], 100, 10, 0, 10)).toEqual([[0, 5]]);
	});
});

describe('sparklineBars', () => {
	it('rises from the baseline (min ?? 0) to each value, evenly slotted', () => {
		// width 100 over 2 samples → slot 50, gap 0.2 → bar width 40, centred (offset 5).
		const bars = sparklineBars([0, 100], 100, 10, 0, 100);
		expect(bars).toEqual([
			{ x: 5, y: 10, w: 40, h: 0 },
			{ x: 55, y: 0, w: 40, h: 10 }
		]);
	});

	it('autoscales the top to the data max when max is null', () => {
		const bars = sparklineBars([5, 10], 100, 20, 0, null);
		expect(bars[0].h).toBe(10); // 5/10 of 20
		expect(bars[1].h).toBe(20); // the max fills the height
	});

	it('clamps out-of-range values and returns empty for no history', () => {
		expect(sparklineBars([150], 10, 10, 0, 100)[0].h).toBe(10); // clamped to 1.0
		expect(sparklineBars([], 10, 10)).toEqual([]);
	});

	it('right-anchors to a fixed window, leaving early slots empty', () => {
		// window 4, 1 sample → it occupies only the rightmost slot (3 of 4); no stretching.
		const bars = sparklineBars([100], 100, 10, 0, 100, 0.2, 4);
		expect(bars).toHaveLength(1);
		expect(bars[0].x).toBeCloseTo(77.5); // slot 3 of 4: 3*25 + (25-20)/2
		expect(bars[0].h).toBe(10);
	});

	it('floors a zero span (pinned min === max) to a divide-by-zero-safe 1', () => {
		const bars = sparklineBars([5, 5], 100, 10, 5, 5);
		expect(bars[0].h).toBe(0);
		expect(bars[1].h).toBe(0);
	});

	it('defaults an unpinned min to 0 (baseline) with no min/max args at all', () => {
		// min/max both default to null → lo falls back to 0, hi falls back to the data max.
		const bars = sparklineBars([5, 10], 100, 20);
		expect(bars[0].h).toBe(10); // 5 / (data max 10) of 20
		expect(bars[1].h).toBe(20);
	});
});
