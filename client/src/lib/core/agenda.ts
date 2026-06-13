// Pure logic for the Agenda widget. No React/Tauri — unit-tested. The backend (widgetsack/src/agenda.rs)
// parses an ICS feed into AgendaEvent rows (summary + ISO start) and emits them as the `agenda.list`
// JSON sensor; this side filters to the upcoming events and formats a friendly "when" label (it has
// the clock + locale, so the time work lives here).

/** One calendar event. Mirrors Rust `AgendaEvent` (camelCase). `start` is an ISO-8601 string (UTC `…Z`,
 * floating, or a date-only `YYYY-MM-DD` for all-day). */
export type AgendaEvent = { summary: string; start: string; allDay: boolean; location: string };

/** Defensively parse the `agenda.list` JSON sensor value into typed events (malformed rows dropped). */
export function parseAgendaList(value: unknown): AgendaEvent[] {
	if (!Array.isArray(value)) return [];
	const out: AgendaEvent[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') continue;
		const r = raw as Record<string, unknown>;
		if (typeof r.summary !== 'string' || !r.summary) continue;
		if (typeof r.start !== 'string' || !r.start) continue;
		out.push({
			summary: r.summary,
			start: r.start,
			allDay: r.allDay === true,
			location: typeof r.location === 'string' ? r.location : ''
		});
	}
	return out;
}

const startMs = (ev: AgendaEvent): number => new Date(ev.start).getTime();
const localMidnight = (ms: number): number => {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
};

/** The upcoming events, soonest first, capped to `max`. A timed event counts as upcoming until an hour
 * after it starts (so a meeting you're in still shows); an all-day event shows for the whole day. */
export function upcomingEvents(events: AgendaEvent[], nowMs: number, max: number): AgendaEvent[] {
	const todayMs = localMidnight(nowMs);
	const graceMs = nowMs - 3_600_000;
	return events
		.map((e) => ({ e, ms: startMs(e) }))
		.filter((x) => !Number.isNaN(x.ms) && (x.e.allDay ? x.ms >= todayMs : x.ms >= graceMs))
		.sort((a, b) => a.ms - b.ms)
		.slice(0, Math.max(0, max))
		.map((x) => x.e);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** A friendly "when" label for an event start: Today / Tomorrow / weekday (this week) / "D Mon",
 * with the HH:mm appended for timed events. Pure (nowMs in). '' for an unparseable start. */
export function formatEventWhen(startIso: string, allDay: boolean, nowMs: number): string {
	const start = new Date(startIso);
	const sMs = start.getTime();
	if (Number.isNaN(sMs)) return '';
	const dayDiff = Math.round((localMidnight(sMs) - localMidnight(nowMs)) / 86_400_000);
	let day: string;
	if (dayDiff === 0) day = 'Today';
	else if (dayDiff === 1) day = 'Tomorrow';
	else if (dayDiff > 1 && dayDiff < 7) day = WEEKDAYS[start.getDay()];
	else day = `${start.getDate()} ${MONTHS[start.getMonth()]}`;
	return allDay ? day : `${day} ${pad(start.getHours())}:${pad(start.getMinutes())}`;
}
