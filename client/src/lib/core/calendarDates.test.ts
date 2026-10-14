import ICAL from 'ical.js';
import { expect, it } from 'vitest';
import { normalizeCalendarDates } from './calendarDates';
it('rejects non-string temporal values before hydration', () => {
	const component = new ICAL.Component(['vevent', [['dtstart', {}, 'date', null]], []]);
	expect(() => normalizeCalendarDates(component)).toThrow('Invalid calendar date');
});
