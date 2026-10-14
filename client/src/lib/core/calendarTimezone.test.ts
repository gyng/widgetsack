import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { browserTimezone, calendarOffsetSeconds } from './calendarTimezone';
const iso = (timezone: string, date: string) => {
	const time = ICAL.Time.fromDateTimeString(date);
	time.zone = browserTimezone(timezone);
	return time.toJSDate().toISOString();
};
describe('browser timezone adapter', () => {
	it('resolves daylight-saving folds and gaps with RFC5545 semantics', () => {
		expect(iso('America/New_York', '2026-11-01T01:30:00')).toBe('2026-11-01T05:30:00.000Z');
		expect(iso('America/New_York', '2026-03-08T02:30:00')).toBe('2026-03-08T07:30:00.000Z');
	});
	it('handles quarter-hour offsets, UTC, and invalid zones', () => {
		expect(iso('Asia/Kathmandu', '2026-10-14T09:00:00')).toBe('2026-10-14T03:15:00.000Z');
		expect(iso('UTC', '2026-10-14T09:00:00')).toBe('2026-10-14T09:00:00.000Z');
		expect(() => browserTimezone('Not/AZone')).toThrow();
	});
});

it('validates VTIMEZONE offsets without dropping seconds or wrapping hours', () => {
	expect(calendarOffsetSeconds('+03:30:45')).toBe(12645);
	expect(calendarOffsetSeconds('-15:00')).toBe(-54000);
	for (const invalid of [null, 'bad', '+24:00', '+03:60', '+03:00:60'])
		expect(calendarOffsetSeconds(invalid)).toBeNull();
});

it('keeps offset calculations correct after the bounded cache rolls over', () => {
	const zone = browserTimezone('Europe/London', 2);
	const dates = [
		'2026-01-01T09:00:00',
		'2026-07-01T09:00:00',
		'2026-12-01T09:00:00',
		'2026-01-01T09:00:00'
	];
	expect(
		dates.map((date) => {
			const time = ICAL.Time.fromDateTimeString(date);
			time.zone = zone;
			return time.toJSDate().toISOString();
		})
	).toEqual([
		'2026-01-01T09:00:00.000Z',
		'2026-07-01T08:00:00.000Z',
		'2026-12-01T09:00:00.000Z',
		'2026-01-01T09:00:00.000Z'
	]);
});
