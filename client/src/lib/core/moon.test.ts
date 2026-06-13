import { describe, it, expect } from 'vitest';
import { moonPhase, moonInfo, sunTime } from './moon';

const REF_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);
const SYNODIC_MS = 29.530588853 * 86_400_000;

describe('moonPhase', () => {
	it('is ~new at the reference epoch and ~full half a cycle later', () => {
		expect(moonPhase(REF_NEW_MOON)).toBeCloseTo(0, 3);
		expect(moonPhase(REF_NEW_MOON + SYNODIC_MS / 2)).toBeCloseTo(0.5, 3);
		expect(moonPhase(REF_NEW_MOON + SYNODIC_MS / 4)).toBeCloseTo(0.25, 3);
	});

	it('wraps into 0..1', () => {
		const p = moonPhase(REF_NEW_MOON + SYNODIC_MS * 3.5);
		expect(p).toBeGreaterThanOrEqual(0);
		expect(p).toBeLessThan(1);
		expect(p).toBeCloseTo(0.5, 3);
	});
});

describe('moonInfo', () => {
	it('names + illuminates the cardinal phases', () => {
		expect(moonInfo(0)).toMatchObject({ name: 'New', icon: '🌑' });
		expect(moonInfo(0).illumination).toBeCloseTo(0, 3);
		expect(moonInfo(0.5)).toMatchObject({ name: 'Full', icon: '🌕' });
		expect(moonInfo(0.5).illumination).toBeCloseTo(1, 3);
		expect(moonInfo(0.25)).toMatchObject({ name: 'First quarter', icon: '🌓' });
		expect(moonInfo(0.25).illumination).toBeCloseTo(0.5, 3);
	});
});

describe('sunTime', () => {
	it('slices HH:mm from an ISO string', () => {
		expect(sunTime('2026-06-14T05:12')).toBe('05:12');
		expect(sunTime('2026-06-14T21:30:00')).toBe('21:30');
	});
	it('returns null for empty / non-ISO', () => {
		expect(sunTime(null)).toBeNull();
		expect(sunTime('')).toBeNull();
		expect(sunTime('2026-06-14')).toBeNull();
	});
});
