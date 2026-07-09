import { describe, expect, it } from 'vitest';
import {
	arcDasharray,
	arcRotation,
	clampPips,
	clampSweep,
	dialTickCount,
	dialTicks,
	directionAxis,
	needleAngle,
	pipArcPositions,
	pipFilledCount,
	pipRadius,
	pipSegments,
	polar
} from './gaugeMath';

// The Gauge's geometry constants (SIZE 100, STROKE 9).
const R = (100 - 9) / 2;
const C = 2 * Math.PI * R;

describe('clampSweep / clampPips', () => {
	it('clamps the sweep to [90, 360] and defaults non-finite to 270', () => {
		expect(clampSweep(270)).toBe(270);
		expect(clampSweep(10)).toBe(90);
		expect(clampSweep(720)).toBe(360);
		expect(clampSweep(NaN)).toBe(270);
	});
	it('rounds + clamps the pip count and defaults non-finite to 10', () => {
		expect(clampPips(10)).toBe(10);
		expect(clampPips(7.6)).toBe(8);
		expect(clampPips(0)).toBe(1);
		expect(clampPips(999)).toBe(60);
		expect(clampPips(NaN)).toBe(10);
	});
});

describe('arcRotation', () => {
	it('reproduces the legacy rotate(135) for the classic 270° sweep', () => {
		expect(arcRotation(270)).toBe(135);
	});
	it('keeps the gap centred at the bottom for other sweeps', () => {
		expect(arcRotation(180)).toBe(180); // semicircle: starts at the left horizon
		expect(arcRotation(360)).toBe(90); // no gap: starts straight down
	});
});

describe('arcDasharray', () => {
	it('matches the legacy 270° strings byte-for-byte (track and fill)', () => {
		const SWEEP = 0.75; // the old constant
		expect(arcDasharray(C, 270)).toBe(`${SWEEP * C} ${C}`);
		const frac = 0.42;
		expect(arcDasharray(C, 270, frac)).toBe(`${frac * SWEEP * C} ${C}`);
	});
	it('a 360° sweep spans the whole circumference', () => {
		expect(arcDasharray(C, 360, 0.5)).toBe(`${0.5 * C} ${C}`);
	});
});

describe('needleAngle', () => {
	it('sweeps from the arc start to its end', () => {
		expect(needleAngle(0, 270)).toBe(135);
		expect(needleAngle(0.5, 270)).toBe(270); // straight up
		expect(needleAngle(1, 270)).toBe(405); // ≡ 45°, the arc end
	});
});

describe('pipFilledCount', () => {
	it('rounds to the nearest pip and clamps to [0, n]', () => {
		expect(pipFilledCount(0, 10)).toBe(0);
		expect(pipFilledCount(0.74, 20)).toBe(15);
		expect(pipFilledCount(0.04, 10)).toBe(0);
		expect(pipFilledCount(0.05, 10)).toBe(1);
		expect(pipFilledCount(1, 10)).toBe(10);
		expect(pipFilledCount(1.2, 10)).toBe(10);
	});
});

describe('pipArcPositions', () => {
	it('places the first/last pips at the arc ends and the middle pip at the top', () => {
		const pts = pipArcPositions(3, 270, 50, 50, R);
		expect(pts).toHaveLength(3);
		expect(pts[0].x).toBeCloseTo(polar(50, 50, R, 135).x);
		expect(pts[0].y).toBeCloseTo(polar(50, 50, R, 135).y);
		expect(pts[1].x).toBeCloseTo(50);
		expect(pts[1].y).toBeCloseTo(50 - R);
		expect(pts[2].x).toBeCloseTo(polar(50, 50, R, 405).x);
		expect(pts[2].y).toBeCloseTo(polar(50, 50, R, 405).y);
	});
	it('a single pip sits mid-arc', () => {
		const [p] = pipArcPositions(1, 270, 50, 50, R);
		expect(p.x).toBeCloseTo(50);
		expect(p.y).toBeCloseTo(50 - R);
	});
});

describe('pipRadius', () => {
	it('caps few pips at the maximum dot size and shrinks dense ones below their spacing', () => {
		expect(pipRadius(10, 270, R)).toBe(5);
		const dense = pipRadius(40, 270, R);
		const spacing = ((270 / 360) * 2 * Math.PI * R) / 39;
		expect(dense).toBeLessThan(spacing / 2); // neighbours never touch
		expect(dense).toBeGreaterThanOrEqual(1);
	});
});

describe('directionAxis', () => {
	it('maps each direction to an axis + fill end', () => {
		expect(directionAxis('ltr')).toEqual({ vertical: false, reverse: false });
		expect(directionAxis('rtl')).toEqual({ vertical: false, reverse: true });
		expect(directionAxis('ttb')).toEqual({ vertical: true, reverse: false });
		expect(directionAxis('btt')).toEqual({ vertical: true, reverse: true });
		expect(directionAxis('arc')).toEqual({ vertical: false, reverse: false });
	});
});

describe('pipSegments', () => {
	it('ltr fills left → right with the slot gap split around each segment', () => {
		const segs = pipSegments(4, 'ltr', 0.25);
		expect(segs).toHaveLength(4);
		expect(segs[0]).toEqual({ x: 3.125, y: 0, w: 18.75, h: 100 });
		expect(segs.map((s) => s.x)).toEqual([3.125, 28.125, 53.125, 78.125]);
	});
	it('rtl puts the FIRST-filled segment at the right edge', () => {
		const segs = pipSegments(4, 'rtl', 0.25);
		expect(segs[0].x).toBe(78.125);
		expect(segs[3].x).toBe(3.125);
	});
	it('btt fills bottom → top, ttb top → bottom (vertical segments)', () => {
		const btt = pipSegments(4, 'btt', 0.25);
		expect(btt[0]).toEqual({ x: 0, y: 78.125, w: 100, h: 18.75 });
		expect(btt[3].y).toBe(3.125);
		const ttb = pipSegments(4, 'ttb', 0.25);
		expect(ttb[0].y).toBe(3.125);
	});
});

describe('dialTicks', () => {
	it('270° gets one tick per 30°, endpoints inclusive', () => {
		expect(dialTickCount(270)).toBe(10);
		expect(dialTickCount(180)).toBe(7);
	});
	it('the first tick lies on the arc-start ray', () => {
		const ticks = dialTicks(270, dialTickCount(270), 50, 50, R - 7, R);
		expect(ticks).toHaveLength(10);
		const inner = polar(50, 50, R - 7, 135);
		const outer = polar(50, 50, R, 135);
		expect(ticks[0].x1).toBeCloseTo(inner.x);
		expect(ticks[0].y1).toBeCloseTo(inner.y);
		expect(ticks[0].x2).toBeCloseTo(outer.x);
		expect(ticks[0].y2).toBeCloseTo(outer.y);
	});
	it('a single tick sits mid-arc (avoids a divide-by-zero at count - 1)', () => {
		const [tick] = dialTicks(270, 1, 50, 50, R - 7, R);
		const inner = polar(50, 50, R - 7, 270);
		const outer = polar(50, 50, R, 270);
		expect(tick.x1).toBeCloseTo(inner.x);
		expect(tick.y1).toBeCloseTo(inner.y);
		expect(tick.x2).toBeCloseTo(outer.x);
		expect(tick.y2).toBeCloseTo(outer.y);
	});
});
