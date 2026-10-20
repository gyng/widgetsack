import { expect, it } from 'vitest';
import { nextScroll, scrollAt, pixelScrollOffset } from './scrollClock';
import { sparklinePoints } from './sparklineMath';

it('preserves the position of recorded points across early, on-time and late arrivals', () => {
	for (const arrival of [900, 1000, 1150]) {
		const clock = nextScroll(null, 0);
		const before = sparklinePoints([10, 20], 100, 50, 0, 100, 2, scrollAt(clock, arrival))[1];
		const next = nextScroll(clock, arrival);
		const after = sparklinePoints([20, 30], 100, 50, 0, 100, 2, scrollAt(next, arrival))[0];
		expect(after).toEqual(before);
		expect(scrollAt(next, arrival + 500)).toBeGreaterThan(next.phase);
		expect(scrollAt(next, arrival + 1000)).toBe(1);
	}
});

it('resets changed series and tolerates paused or backwards clocks', () => {
	expect(nextScroll({ at: 0, phase: 0.5, samples: 4 }, 100, false)).toEqual({
		at: 100,
		phase: 0,
		samples: 0
	});
	expect(scrollAt({ at: 100, phase: -0.1, samples: 0 }, 0)).toBe(-0.1);
	expect(nextScroll({ at: 100, phase: -2, samples: 0 }, 100).phase).toBe(-1);
});

it('recovers counters retained by a development hot reload instead of drawing NaN coordinates', () => {
	for (const clock of [
		{ at: 0, phase: 0 },
		{ at: 0, phase: 0, samples: NaN }
	]) {
		expect(pixelScrollOffset(clock, 0.5, 2.2)).toBe(-1);
		expect(nextScroll(clock, 500).samples).toBe(1);
	}
});

it('moves narrow core traces by whole physical pixels without changing alignment on a sample boundary', () => {
	const slot = 2.2;
	let clock = nextScroll(null, 0);
	let previous = 10 * slot;
	for (const now of [100, 300, 600, 900]) {
		const x = 10 * slot + pixelScrollOffset(clock, scrollAt(clock, now), slot);
		expect(x - previous).toBeCloseTo(Math.round(x - previous));
		previous = x;
	}
	clock = nextScroll(clock, 900);
	const after = 9 * slot + pixelScrollOffset(clock, scrollAt(clock, 900), slot);
	expect(after).toBeCloseTo(previous);
	const next = 9 * slot + pixelScrollOffset(clock, scrollAt(clock, 1100), slot);
	expect(next - after).toBeCloseTo(Math.round(next - after));
});
