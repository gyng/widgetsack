import { describe, expect, it } from 'vitest';
import { expandCalendar } from './calendarFeed';
const feed = (...events: string[]) => `BEGIN:VCALENDAR
VERSION:2.0
${events.join('\n')}
END:VCALENDAR`;
const event = (body: string) => `BEGIN:VEVENT
${body}
END:VEVENT`;
const now = Date.parse('2026-10-14T00:00:00Z');
const rows = (calendar: string, at = now) => expandCalendar(calendar, at).events;

describe('calendar feeds', () => {
	it('retains independent occurrence identities across title changes and feed reordering', () => {
		const a = event('UID:first\nSUMMARY:Standup\nDTSTART:20261014T090000Z');
		const b = event('UID:second\nSUMMARY:Standup\nDTSTART:20261014T090000Z');
		const before = rows(feed(a, b));
		expect(new Set(before.map((e) => e.id)).size).toBe(2);
		const after = rows(feed(b, a.replace('Standup', 'New title')));
		expect(after.find((e) => e.summary === 'New title')!.id).toBe(
			before.find((e) => e.id === 'named:first:single')!.id
		);
	});
	it('expands old weekly events and preserves daylight-saving clock time', () => {
		const result = rows(
			feed(
				event(`UID:weekly
SUMMARY:Standup
DTSTART;TZID=Europe/London:20261014T093000
RRULE:FREQ=WEEKLY;COUNT=4`)
			)
		);
		expect(result.map((e) => e.start)).toEqual([
			'2026-10-14T08:30:00.000Z',
			'2026-10-21T08:30:00.000Z',
			'2026-10-28T09:30:00.000Z',
			'2026-11-04T09:30:00.000Z'
		]);
		expect(
			rows(
				feed(
					event(`UID:old
SUMMARY:Weekly
DTSTART:20200101T090000Z
RRULE:FREQ=WEEKLY`)
				),
				now
			).some((e) => e.start === '2026-10-14T09:00:00.000Z')
		).toBe(true);
	});
	it('honors exclusions, additional dates, count, and an inclusive until boundary', () => {
		const result = rows(
			feed(
				event(`UID:one
SUMMARY:Call
DTSTART:20261014T090000Z
RRULE:FREQ=DAILY;COUNT=3
EXDATE:20261015T090000Z
RDATE:20261019T090000Z`)
			)
		);
		expect(result.map((e) => e.start)).toEqual([
			'2026-10-14T09:00:00.000Z',
			'2026-10-16T09:00:00.000Z',
			'2026-10-19T09:00:00.000Z'
		]);
		expect(
			rows(
				feed(
					event(`UID:until
SUMMARY:Call
DTSTART:20261014T090000Z
RRULE:FREQ=DAILY;UNTIL=20261015T090000Z`)
				)
			).map((e) => e.start)
		).toEqual(['2026-10-14T09:00:00.000Z', '2026-10-15T09:00:00.000Z']);
	});
	it('links moved and cancelled occurrences to their own series only', () => {
		const result = rows(
			feed(
				event(`UID:a
SUMMARY:A
DTSTART:20261014T090000Z
RRULE:FREQ=DAILY;COUNT=3`),
				event(`UID:b
SUMMARY:B
DTSTART:20261014T090000Z
RRULE:FREQ=DAILY;COUNT=2`),
				event(`UID:a
RECURRENCE-ID:20261015T090000Z
DTSTART:20261015T110000Z
SUMMARY:Moved A`),
				event(`UID:a
RECURRENCE-ID:20261016T090000Z
STATUS:CANCELLED`)
			)
		);
		expect(result.map((e) => [e.summary, e.start])).toEqual([
			['A', '2026-10-14T09:00:00.000Z'],
			['B', '2026-10-14T09:00:00.000Z'],
			['B', '2026-10-15T09:00:00.000Z'],
			['Moved A', '2026-10-15T11:00:00.000Z']
		]);
	});
	it('keeps a moved occurrence whose original date is far in the past', () => {
		const result = rows(
			feed(
				event(`UID:a
SUMMARY:A
DTSTART:20200101T090000Z
RRULE:FREQ=DAILY;COUNT=2`),
				event(`UID:a
RECURRENCE-ID:20200102T090000Z
DTSTART:20261014T110000Z`)
			)
		);
		expect(result).toEqual([
			{
				id: 'named:a:1577955600',
				summary: 'A',
				start: '2026-10-14T11:00:00.000Z',
				allDay: false,
				location: ''
			}
		]);
	});
	it('keeps all-day occurrences as calendar dates', () => {
		expect(
			rows(
				feed(
					event(`UID:day
SUMMARY:Holiday
DTSTART;VALUE=DATE:20261014
RRULE:FREQ=DAILY;COUNT=2`)
				)
			).map((e) => e.start)
		).toEqual(['2026-10-14', '2026-10-15']);
	});
	it('uses embedded timezone rules before environment timezone rules', () => {
		const timezone = `BEGIN:VTIMEZONE
TZID:Europe/London
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+0300
TZOFFSETTO:+0300
END:STANDARD
END:VTIMEZONE`;
		expect(
			rows(
				feed(
					timezone,
					event(`UID:embedded
SUMMARY:Custom zone
DTSTART;TZID=Europe/London:20261014T093000`)
				)
			)[0].start
		).toBe('2026-10-14T06:30:00.000Z');
		expect(
			rows(
				feed(
					event(`UID:normal
SUMMARY:London
DTSTART;TZID=Europe/London:20261014T093000`)
				)
			)[0].start
		).toBe('2026-10-14T08:30:00.000Z');
	});
	it('reports unknown timezones and malformed events without hiding valid events', () => {
		const result = expandCalendar(
			feed(
				event(`UID:bad
SUMMARY:Unknown
DTSTART;TZID=Not/AZone:20261014T093000`),
				event(`UID:good
SUMMARY:Good
DTSTART:20261014T100000Z`)
			),
			now
		);
		expect(result.events.map((e) => e.summary)).toEqual(['Good']);
		expect(result.warnings.length).toBeGreaterThan(0);
		expect(expandCalendar('not a calendar', now).warnings.length).toBeGreaterThan(0);
	});
	it('chooses the latest event revision and excludes cancelled series', () => {
		expect(
			rows(
				feed(
					event(`UID:a
SEQUENCE:1
SUMMARY:Old
DTSTART:20261014T090000Z`),
					event(`UID:a
SEQUENCE:2
SUMMARY:New
DTSTART:20261014T110000Z`),
					event(`UID:b
SUMMARY:Cancelled
DTSTART:20261014T120000Z
STATUS:CANCELLED`)
				)
			).map((e) => e.summary)
		).toEqual(['New']);
	});
});

it('supports period-valued RDATE entries and recurring exclusions', () => {
	expect(
		rows(
			feed(
				event(`UID:period
SUMMARY:Extra
DTSTART:20261014T090000Z
RDATE;VALUE=PERIOD:20261015T110000Z/PT2H`)
			)
		).map((e) => e.start)
	).toEqual(['2026-10-14T09:00:00.000Z', '2026-10-15T11:00:00.000Z']);
	expect(
		rows(
			feed(
				event(`UID:exclude
SUMMARY:Call
DTSTART:20261014T090000Z
RRULE:FREQ=DAILY;COUNT=3
EXRULE:FREQ=DAILY;INTERVAL=2;COUNT=2`)
			)
		).map((e) => e.start)
	).toEqual(['2026-10-15T09:00:00.000Z']);
});
it('skips malformed exceptions without losing the valid recurring series', () => {
	const result = expandCalendar(
		feed(
			event(`UID:a
SUMMARY:Call
DTSTART:20261014T090000Z
RRULE:FREQ=DAILY;COUNT=2`),
			event(`UID:a
RECURRENCE-ID:20261015T090000Z
SUMMARY:Broken exception`)
		),
		now
	);
	expect(result.events.map((e) => e.start)).toEqual([
		'2026-10-14T09:00:00.000Z',
		'2026-10-15T09:00:00.000Z'
	]);
	expect(result.warnings.length).toBeGreaterThan(0);
});
it.each(['20261314T090000Z', '20260230T090000Z', '20261014T250000Z'])(
	'does not normalize malformed calendar dates into a different event: %s',
	(start) => {
		const result = expandCalendar(
			feed(
				event(`UID:bad
SUMMARY:Bad
DTSTART:${start}`)
			),
			now
		);
		expect(result.events).toEqual([]);
		expect(result.warnings.length).toBeGreaterThan(0);
	}
);
it('applies THISANDFUTURE moves and cancellations without duplicate original occurrences', () => {
	expect(
		rows(
			feed(
				event(`UID:a
SUMMARY:Call
DTSTART:20261014T090000Z
RRULE:FREQ=DAILY;COUNT=4`),
				event(`UID:a
RECURRENCE-ID;RANGE=THISANDFUTURE:20261015T090000Z
DTSTART:20261015T110000Z
SUMMARY:Later`),
				event(`UID:a
RECURRENCE-ID;RANGE=THISANDFUTURE:20261017T090000Z
STATUS:CANCELLED`)
			)
		).map((e) => [e.summary, e.start])
	).toEqual([
		['Call', '2026-10-14T09:00:00.000Z'],
		['Later', '2026-10-15T11:00:00.000Z'],
		['Later', '2026-10-16T11:00:00.000Z']
	]);
});

it('does not let historical rows occupy the bounded upcoming event list', () => {
	const previous = Array.from({ length: 6 }, (_, i) =>
		event(`UID:past-${i}
SUMMARY:Past
DTSTART:20261013T090000Z`)
	);
	const result = expandCalendar(
		feed(
			...previous,
			event(`UID:future
SUMMARY:Future
DTSTART:20261014T110000Z`)
		),
		Date.parse('2026-10-14T10:00:00Z'),
		{ maxEvents: 3 }
	);
	expect(result.events.map((e) => e.summary)).toEqual(['Future']);
	expect(result.warnings).toEqual([]);
});

it('isolates malformed timezone definitions from valid IANA events', () => {
	const result = expandCalendar(
		feed(
			`BEGIN:VTIMEZONE
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+0000
TZOFFSETTO:+0000
END:STANDARD
END:VTIMEZONE`,
			event(`UID:good
SUMMARY:London
DTSTART;TZID=Europe/London:20261014T093000`)
		),
		now
	);
	expect(result.events[0]?.start).toBe('2026-10-14T08:30:00.000Z');
	expect(result.warnings.length).toBeGreaterThan(0);
});

it('preserves seconds in feed-defined timezone offsets', () => {
	expect(
		rows(
			feed(
				`BEGIN:VTIMEZONE
TZID:Custom
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+033045
TZOFFSETTO:+033045
END:STANDARD
END:VTIMEZONE`,
				event(`UID:custom
SUMMARY:Custom
DTSTART;TZID=Custom:20261014T093000`)
			)
		)[0].start
	).toBe('2026-10-14T05:59:15.000Z');
});

it('keeps titles, locations, and exceptions separate when recurrence schedules match', () => {
	const result = rows(
		feed(
			event(`UID:a
SUMMARY:A
LOCATION:Room A
DTSTART:20261014T090000Z
RRULE:FREQ=DAILY;COUNT=2`),
			event(`UID:b
SUMMARY:B
LOCATION:Room B
DTSTART:20261014T090000Z
RRULE:FREQ=DAILY;COUNT=2`),
			event(`UID:b
RECURRENCE-ID:20261015T090000Z
STATUS:CANCELLED`)
		)
	);
	expect(result.map((e) => [e.summary, e.location, e.start])).toEqual([
		['A', 'Room A', '2026-10-14T09:00:00.000Z'],
		['B', 'Room B', '2026-10-14T09:00:00.000Z'],
		['A', 'Room A', '2026-10-15T09:00:00.000Z']
	]);
});
it('keeps output chronological, reports caps, and preserves distant one-off events', () => {
	const result = expandCalendar(
		feed(
			event(`UID:late
SUMMARY:Later
DTSTART:20261020T100000Z`),
			event(`UID:soon
SUMMARY:Soon
DTSTART:20261014T100000Z`),
			event(`UID:middle
SUMMARY:Middle
DTSTART:20261015T100000Z`)
		),
		now,
		{ maxEvents: 2 }
	);
	expect(result.events.map((e) => e.summary)).toEqual(['Soon', 'Middle']);
	expect(result.warnings).toEqual(['Only the first 2 calendar events are shown.']);
	expect(
		rows(
			feed(
				event(`UID:distant
SUMMARY:One-off
DTSTART:20300101T090000Z`)
			)
		)[0].summary
	).toBe('One-off');
});
it('reports exhausted expansion budgets while retaining completed rows', () => {
	const result = expandCalendar(
		feed(
			event(`UID:daily
SUMMARY:Daily
DTSTART:20261014T090000Z
RRULE:FREQ=DAILY`)
		),
		now,
		{ maxIterations: 2 }
	);
	expect(result.events).toHaveLength(2);
	expect(result.warnings).toEqual(['A calendar recurrence exceeded the processing limit.']);
});
it('selects the latest master and exception revisions by sequence and timestamp', () => {
	const result = rows(
		feed(
			event(`UID:a
SUMMARY:New
DTSTART:20261014T090000Z
RRULE:FREQ=DAILY;COUNT=2
SEQUENCE:2
DTSTAMP:20261012T120000Z`),
			event(`UID:a
SUMMARY:Old
DTSTART:20261014T100000Z
SEQUENCE:1`),
			event(`UID:a
SUMMARY:Outdated
DTSTART:20261014T100000Z
SEQUENCE:2
DTSTAMP:20261011T120000Z`),
			event(`UID:a
RECURRENCE-ID:20261015T090000Z
SUMMARY:New exception
DTSTART:20261015T110000Z
SEQUENCE:2`),
			event(`UID:a
RECURRENCE-ID:20261015T090000Z
SUMMARY:Old exception
DTSTART:20261015T100000Z
SEQUENCE:1`)
		)
	);
	expect(result.map((e) => e.summary)).toEqual(['New', 'New exception']);
});
it('keeps detached and anonymous events distinct, including a named anonymous-like UID', () => {
	expect(
		rows(
			feed(
				event(`SUMMARY:Anonymous
DTSTART:20261014T090000Z`),
				event(`UID:anonymous:0
SUMMARY:Named
DTSTART:20261014T090000Z`),
				event(`UID:detached
SUMMARY:Detached
RECURRENCE-ID:20261014T090000Z
DTSTART:20261014T100000Z`)
			)
		).map((e) => e.summary)
	).toEqual(['Anonymous', 'Named', 'Detached']);
});
it('ignores cancelled feeds and reports oversized input and invalid clocks', () => {
	expect(
		expandCalendar(
			feed(
				'METHOD:CANCEL',
				event(`UID:a
SUMMARY:Cancelled
DTSTART:20261014T090000Z`)
			),
			now
		)
	).toEqual({ events: [], warnings: [] });
	expect(expandCalendar('x'.repeat(1048577), now).warnings.length).toBe(1);
	expect(expandCalendar(feed(), NaN).warnings.length).toBe(1);
	expect(expandCalendar('BEGIN:VEVENT\nEND:VEVENT', now).warnings.length).toBe(1);
});
it('handles advanced monthly and yearly rules rather than approximating with fixed day intervals', () => {
	const monthly = rows(
		feed(
			event(`UID:monthly
SUMMARY:Month end
DTSTART:20261030T090000Z
RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3`)
		)
	);
	expect(monthly.map((e) => e.start)).toEqual([
		'2026-10-30T09:00:00.000Z',
		'2026-11-30T09:00:00.000Z',
		'2026-12-31T09:00:00.000Z'
	]);
	expect(
		rows(
			feed(
				event(`UID:yearly
SUMMARY:Anniversary
DTSTART;VALUE=DATE:20260228
RRULE:FREQ=YEARLY;COUNT=3`)
			)
		).map((e) => e.start)
	).toEqual(['2027-02-28']);
});
it('does not drop results when recurrence memoization spills or evicts a pattern', () => {
	const many = Array.from({ length: 10 }, (_, i) =>
		event(`UID:${i}
SUMMARY:Call ${i}
DTSTART:20261014T09000${i % 9}Z
RRULE:FREQ=DAILY;COUNT=2`)
	);
	expect(rows(feed(...many))).toHaveLength(20);
	const hourly = event(`UID:hourly
SUMMARY:Hourly
DTSTART:20261014T000000Z
RRULE:FREQ=HOURLY;COUNT=4200`);
	const spilled = expandCalendar(feed(hourly), now);
	expect(spilled.events).toHaveLength(2048);
	expect(spilled.events[0].start).toBe('2026-10-14T00:00:00.000Z');
});

it('rejects unparseable dates, invalid leap days, missing titles, and non-temporal starts', () => {
	for (const body of [
		`SUMMARY:Bad
DTSTART:bad`,
		`SUMMARY:Leap
DTSTART;VALUE=DATE:21000229`,
		`DTSTART:20261014T090000Z`,
		`SUMMARY:Text start
DTSTART;VALUE=TEXT:not-a-date`
	]) {
		const result = expandCalendar(feed(event(body)), now);
		expect(result.events).toEqual([]);
		expect(result.warnings.length).toBeGreaterThan(0);
	}
	expect(
		expandCalendar(
			feed(
				event(`SUMMARY:Leap
DTSTART;VALUE=DATE:20000229`)
			),
			now
		).warnings
	).toEqual([]);
});
it('reports invalid recurrence rules and calendar date overflow', () => {
	for (const rule of ['FREQ=NOTAFREQUENCY', 'FREQ=YEARLY;INTERVAL=1000000;COUNT=2']) {
		const result = expandCalendar(
			feed(
				event(`UID:bad-rule
SUMMARY:Rule
DTSTART:20261014T090000Z
RRULE:${rule}`)
			),
			now
		);
		expect(result.warnings.length).toBeGreaterThan(0);
	}
});
it.each([
	'TZID:Europe/London',
	'TZID:Europe/London\nBEGIN:STANDARD\nTZOFFSETFROM:+0000\nTZOFFSETTO:+0000\nEND:STANDARD',
	'TZID:Europe/London\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETTO:+0000\nEND:STANDARD',
	'TZID:Europe/London\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:+0000\nTZOFFSETTO:+2500\nEND:STANDARD'
])('drops an incomplete timezone definition and reports it: %s', (body) => {
	const result = expandCalendar(
		feed(
			`BEGIN:VTIMEZONE\n${body}\nEND:VTIMEZONE`,
			event(`SUMMARY:Good
DTSTART;TZID=Europe/London:20261014T093000`)
		),
		now
	);
	expect(result.events[0]?.start).toBe('2026-10-14T08:30:00.000Z');
	expect(result.warnings.length).toBeGreaterThan(0);
});
it('shares named timezone lookups and handles negative feed offsets', () => {
	const result = rows(
		feed(
			`BEGIN:VTIMEZONE
TZID:Custom
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:-0300
TZOFFSETTO:-0300
END:STANDARD
END:VTIMEZONE`,
			event(`SUMMARY:A
DTSTART;TZID=Custom:20261014T090000`),
			event(`SUMMARY:B
DTSTART;TZID=Custom:20261014T100000`)
		)
	);
	expect(result.map((e) => e.start)).toEqual([
		'2026-10-14T12:00:00.000Z',
		'2026-10-14T13:00:00.000Z'
	]);
});

it('uses timestamp revisions when a feed omits sequence numbers and accepts textual legacy exclusion rules', () => {
	const revised = rows(
		feed(
			event(`UID:a
SUMMARY:Old
DTSTART:20261014T090000Z
DTSTAMP:20261012T090000Z`),
			event(`UID:a
SUMMARY:New
DTSTART:20261014T100000Z
DTSTAMP:20261013T090000Z`)
		)
	);
	expect(revised.map((e) => e.summary)).toEqual(['New']);
	expect(
		rows(
			feed(
				event(`UID:excluded
SUMMARY:Call
DTSTART:20261014T090000Z
RRULE:FREQ=DAILY;COUNT=3
EXRULE;VALUE=TEXT:FREQ=DAILY;INTERVAL=2;COUNT=2`)
			)
		).map((e) => e.start)
	).toEqual(['2026-10-15T09:00:00.000Z']);
});
