import { expandCalendar } from '../core/calendarFeed';
import type { CalendarResult } from '../core/calendarFeedContract';
const scope = globalThis as unknown as {
	onmessage: ((event: MessageEvent<{ calendar: string; now: number }>) => void) | null;
	postMessage: (result: CalendarResult) => void;
};
scope.onmessage = ({ data }) => scope.postMessage(expandCalendar(data.calendar, data.now));
