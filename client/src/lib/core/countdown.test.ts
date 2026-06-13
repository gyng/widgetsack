import { describe, it, expect } from 'vitest';
import { durationParts, formatCountdown, parseTarget, pomodoroAt } from './countdown';

describe('durationParts', () => {
	it('splits ms into d/h/m/s and floors negatives to zero', () => {
		expect(durationParts((26 * 3600 + 3 * 60 + 4) * 1000)).toEqual({ d: 1, h: 2, m: 3, s: 4 });
		expect(durationParts(-5000)).toEqual({ d: 0, h: 0, m: 0, s: 0 });
	});
});

describe('formatCountdown', () => {
	const ms = (d: number, h: number, m: number, s: number) =>
		((d * 24 + h) * 3600 + m * 60 + s) * 1000;

	it('auto-drops leading zero units', () => {
		expect(formatCountdown(ms(0, 0, 5, 9), 'auto')).toBe('5:09');
		expect(formatCountdown(ms(0, 2, 5, 9), 'auto')).toBe('2:05:09');
		expect(formatCountdown(ms(1, 2, 5, 9), 'auto')).toBe('1d 02:05:09');
	});

	it('honours the fixed formats, folding days into hours/minutes', () => {
		expect(formatCountdown(ms(0, 1, 2, 3), 'dhms')).toBe('0d 01:02:03');
		expect(formatCountdown(ms(1, 1, 0, 0), 'hms')).toBe('25:00:00'); // 1d1h = 25h
		expect(formatCountdown(ms(0, 1, 2, 3), 'ms')).toBe('62:03'); // 1h2m = 62m
	});

	it('prefixes a negative (overdue) duration', () => {
		expect(formatCountdown(-ms(0, 0, 0, 5), 'auto')).toBe('-0:05');
	});
});

describe('parseTarget', () => {
	it('parses a date string to epoch ms', () => {
		expect(parseTarget('2026-01-01T00:00:00Z')).toBe(Date.UTC(2026, 0, 1));
	});
	it('returns null for empty / garbage', () => {
		expect(parseTarget('')).toBeNull();
		expect(parseTarget('   ')).toBeNull();
		expect(parseTarget('not a date')).toBeNull();
	});
});

describe('pomodoroAt', () => {
	const W = 25 * 60_000; // 25 min work
	const B = 5 * 60_000; // 5 min break

	it('starts in work and counts down within the phase', () => {
		expect(pomodoroAt(0, W, B)).toEqual({ phase: 'work', remainingMs: W, cycle: 1 });
		expect(pomodoroAt(60_000, W, B)).toEqual({ phase: 'work', remainingMs: W - 60_000, cycle: 1 });
	});

	it('crosses into the break, then into the next cycle', () => {
		expect(pomodoroAt(W + 60_000, W, B)).toEqual({
			phase: 'break',
			remainingMs: B - 60_000,
			cycle: 1
		});
		const next = pomodoroAt(W + B + 1000, W, B);
		expect(next.phase).toBe('work');
		expect(next.cycle).toBe(2);
	});
});
