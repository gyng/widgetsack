import { describe, it, expect, vi } from 'vitest';
import {
	parseAgendaFeedback,
	parseAgendaList,
	upcomingEvents,
	formatEventWhen,
	type AgendaEvent
} from './agenda';

const ev = (p: Partial<AgendaEvent> & { summary: string; start: string }): AgendaEvent => ({
	allDay: false,
	location: '',
	...p
});

describe('parseAgendaList', () => {
	it('parses well-formed events and drops malformed', () => {
		expect(
			parseAgendaList([
				{ summary: 'Standup', start: '2027-01-02T09:30:00', allDay: false, location: 'Room 2' },
				{ summary: 'No start' },
				{ start: '2027-01-02' },
				5
			])
		).toEqual([
			{ summary: 'Standup', start: '2027-01-02T09:30:00', allDay: false, location: 'Room 2' }
		]);
		expect(parseAgendaList(null)).toEqual([]);
	});

	it('defaults location to an empty string when absent or non-string', () => {
		expect(parseAgendaList([{ summary: 'No location', start: '2027-01-02T09:00:00' }])).toEqual([
			{ summary: 'No location', start: '2027-01-02T09:00:00', allDay: false, location: '' }
		]);
	});
});

describe('upcomingEvents', () => {
	// "now" = Fri 1 Jan 2027, 13:00 local.
	const now = new Date(2027, 0, 1, 13, 0, 0).getTime();

	it('keeps future events, sorts soonest-first, caps', () => {
		const events = [
			ev({ summary: 'Next week', start: new Date(2027, 0, 8, 10, 0).toISOString() }),
			ev({ summary: 'Soon', start: new Date(2027, 0, 1, 15, 0).toISOString() }),
			ev({ summary: 'Long gone', start: new Date(2026, 11, 1, 10, 0).toISOString() })
		];
		expect(upcomingEvents(events, now, 5).map((e) => e.summary)).toEqual(['Soon', 'Next week']);
		expect(upcomingEvents(events, now, 1).map((e) => e.summary)).toEqual(['Soon']);
	});

	it('shows an all-day event for the whole of today', () => {
		const allDayToday = ev({ summary: 'Holiday', start: '2027-01-01', allDay: true });
		// 13:00 is well past midnight, but the all-day event still counts as upcoming today.
		expect(upcomingEvents([allDayToday], now, 5).map((e) => e.summary)).toEqual(['Holiday']);
	});
});

describe('formatEventWhen', () => {
	const now = new Date(2027, 0, 1, 13, 0, 0).getTime(); // Fri 1 Jan 2027

	it('labels relative days with a time for timed events', () => {
		expect(formatEventWhen(new Date(2027, 0, 1, 15, 30).toISOString(), false, now)).toBe(
			'Today 15:30'
		);
		expect(formatEventWhen(new Date(2027, 0, 2, 9, 0).toISOString(), false, now)).toBe(
			'Tomorrow 09:00'
		);
		// 4 Jan 2027 is a Monday (this week → weekday).
		expect(formatEventWhen(new Date(2027, 0, 4, 14, 0).toISOString(), false, now)).toBe(
			'Mon 14:00'
		);
		// Far out → "D Mon".
		expect(formatEventWhen(new Date(2027, 1, 20, 8, 0).toISOString(), false, now)).toBe(
			'20 Feb 08:00'
		);
	});

	it('omits the time for all-day events', () => {
		expect(formatEventWhen('2027-01-01', true, now)).toBe('Today');
		expect(formatEventWhen('2027-01-02', true, now)).toBe('Tomorrow');
	});

	it('keeps explicit timestamps unchanged even when marked all-day', () => {
		expect(formatEventWhen(new Date(2027, 0, 1, 12).toISOString(), true, now)).toBe('Today');
	});

	it("returns '' for an unparseable start", () => {
		expect(formatEventWhen('not a date', false, now)).toBe('');
	});
});

describe('all-day calendar dates across timezones', () => {
	it.each(['America/New_York', 'Asia/Singapore'])('uses the local day in %s', (zone) => {
		vi.stubEnv('TZ', zone);
		try {
			const now = new Date(2027, 0, 1, 13).getTime();
			const holiday = ev({ summary: 'Holiday', start: '2027-01-01', allDay: true });
			const meeting = ev({ summary: 'Meeting', start: new Date(2027, 0, 1, 14).toISOString() });
			expect(upcomingEvents([meeting, holiday], now, 5)).toEqual([holiday, meeting]);
			expect(formatEventWhen(holiday.start, true, now)).toBe('Today');
			expect(formatEventWhen('2027-01-02', true, now)).toBe('Tomorrow');
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

it('reads parse feedback without accepting untyped warning values', () => {
	expect(parseAgendaFeedback(null)).toEqual({ pending: false, warnings: [] });
	expect(parseAgendaFeedback({ pending: true, warnings: ['Warning', 42] })).toEqual({
		pending: true,
		warnings: ['Warning']
	});
	expect(parseAgendaFeedback({ pending: false, warnings: 42 })).toEqual({
		pending: false,
		warnings: []
	});
});

it('preserves valid event IDs and ignores malformed optional IDs in legacy rows', () => {
	const row = { summary: 'Meeting', start: '2026-10-14T09:00:00Z' };
	expect(
		parseAgendaList([
			{ ...row, id: 'one' },
			{ ...row, id: '' },
			{ ...row, id: 123 }
		])
	).toEqual([
		{ ...row, id: 'one', allDay: false, location: '' },
		{ ...row, allDay: false, location: '' },
		{ ...row, allDay: false, location: '' }
	]);
});
