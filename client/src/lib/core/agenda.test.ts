import { describe, it, expect } from 'vitest';
import { parseAgendaList, upcomingEvents, formatEventWhen, type AgendaEvent } from './agenda';

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
});
