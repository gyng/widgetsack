import { describe, it, expect } from 'vitest';
import { cronMatches, describeSchedule, intervalMs, isCron } from './schedule';

describe('intervalMs', () => {
	it('parses units and bare seconds', () => {
		expect(intervalMs('30s')).toBe(30_000);
		expect(intervalMs('5m')).toBe(300_000);
		expect(intervalMs('2h')).toBe(7_200_000);
		expect(intervalMs('1d')).toBe(86_400_000); // days
		expect(intervalMs('90')).toBe(90_000); // bare = seconds
		expect(intervalMs('500ms')).toBe(500);
	});
	it('accepts a fractional value and trims/normalizes whitespace + case', () => {
		expect(intervalMs('1.5h')).toBe(5_400_000);
		expect(intervalMs('  2 M ')).toBe(120_000); // padding + space before unit + uppercase
	});
	it('rejects non-intervals', () => {
		expect(intervalMs('manual')).toBeNull();
		expect(intervalMs('')).toBeNull();
		expect(intervalMs('0 * * * *')).toBeNull();
		expect(intervalMs('abc')).toBeNull();
		expect(intervalMs('0s')).toBeNull();
	});
});

describe('isCron', () => {
	it('recognizes 5-field expressions only', () => {
		expect(isCron('0 * * * *')).toBe(true);
		expect(isCron('*/15 9-17 * * 1-5')).toBe(true);
		expect(isCron('5m')).toBe(false);
		expect(isCron('1 2 3')).toBe(false);
	});
});

describe('cronMatches', () => {
	// Monday, 5 Jan 2026, 09:00 (getDay() === 1).
	const mon0900 = new Date(2026, 0, 5, 9, 0);

	it('matches minute + hour', () => {
		expect(cronMatches('0 9 * * *', mon0900)).toBe(true);
		expect(cronMatches('30 9 * * *', mon0900)).toBe(false);
		expect(cronMatches('0 10 * * *', mon0900)).toBe(false);
	});
	it('handles step and range fields', () => {
		expect(cronMatches('*/15 * * * *', mon0900)).toBe(true); // minute 0 divisible by 15
		expect(cronMatches('0 9-17 * * 1-5', mon0900)).toBe(true); // 9am, weekday
		expect(cronMatches('0 9 * * 6,0', mon0900)).toBe(false); // weekends only
	});
	it('applies dom/dow OR-semantics when both are restricted', () => {
		// the 5th OR a Sunday — the date is the 5th, so it matches even though it is a Monday
		expect(cronMatches('0 9 5 * 0', mon0900)).toBe(true);
		// neither the 6th nor a Sunday -> no match
		expect(cronMatches('0 9 6 * 0', mon0900)).toBe(false);
	});
	it('expands a bare start with a step (N/step = N-max/step)', () => {
		// minute 5/15 -> 5, 20, 35, 50. At minute 0 it must NOT match; build a 09:05.
		const at0905 = new Date(2026, 0, 5, 9, 5);
		expect(cronMatches('5/15 * * * *', at0905)).toBe(true);
		expect(cronMatches('5/15 * * * *', mon0900)).toBe(false); // minute 0 is not in {5,20,35,50}
	});

	it('accepts 7 as Sunday (and ranges spanning it)', () => {
		const sun = new Date(2026, 0, 4, 9, 0); // Sunday 4 Jan 2026, getDay()===0
		expect(cronMatches('0 9 * * 7', sun)).toBe(true);
		expect(cronMatches('0 9 * * 6-7', sun)).toBe(true); // Sat..Sun includes Sunday-as-7
		expect(cronMatches('0 9 * * 7', mon0900)).toBe(false); // Monday is not Sunday
	});

	it('returns false for malformed input', () => {
		expect(cronMatches('not cron', mon0900)).toBe(false);
		expect(cronMatches('0 9 * *', mon0900)).toBe(false);
	});

	it('treats an unparseable step as 1 (every value in the range matches)', () => {
		// "*/x" → step parses to NaN → `|| 1` falls back to 1, so every minute in [0,59] matches.
		expect(cronMatches('*/x 9 * * *', mon0900)).toBe(true); // minute 0, step 1 → match
		expect(cronMatches('*/x 9 * * *', new Date(2026, 0, 5, 9, 37))).toBe(true);
		// "*/0" would divide by zero; the `|| 1` guard turns the 0 step into 1 too.
		expect(cronMatches('*/0 9 * * *', mon0900)).toBe(true);
	});

	it('a list comma-separates alternatives (any part may match)', () => {
		expect(cronMatches('0,30 9 * * *', mon0900)).toBe(true); // minute 0 is the first alternative
		expect(cronMatches('15,30 9 * * *', mon0900)).toBe(false); // minute 0 is neither
	});

	it('rejects a range with a non-numeric bound (NaN bounds → that part never matches)', () => {
		// "a-b" → lo/hi are NaN → the part is skipped; with no other alternative the field never matches.
		expect(cronMatches('a-b 9 * * *', mon0900)).toBe(false);
		// …but a sibling numeric alternative still matches around the bogus range.
		expect(cronMatches('a-b,0 9 * * *', mon0900)).toBe(true);
	});
});

describe('describeSchedule', () => {
	it('labels valid schedules and rejects garbage', () => {
		expect(describeSchedule('5m')).toBe('every 300s');
		expect(describeSchedule('manual')).toBe('manual only');
		expect(describeSchedule('')).toBe('manual only');
		expect(describeSchedule('0 9 * * *')).toBe('cron: 0 9 * * *');
		expect(describeSchedule('garbage')).toBeNull();
	});
});
