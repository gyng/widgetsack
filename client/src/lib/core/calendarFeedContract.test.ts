import { expect, it } from 'vitest';
import { calendarText } from './calendarFeedContract';
it('reads only the supported calendar payload and leaves legacy lists separate', () => {
	expect(calendarText({ version: 1, calendar: 'feed' })).toBe('feed');
	for (const value of [
		null,
		42,
		[],
		{ version: 2, calendar: 'feed' },
		{ version: 1, calendar: 42 }
	])
		expect(calendarText(value)).toBeNull();
});
