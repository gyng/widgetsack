import type { AgendaEvent } from './agenda';
/** Mirrors the agenda.calendar payload emitted by the Rust feed proxy. */
export type AgendaCalendar = { version: 1; calendar: string };
export type CalendarResult = { events: AgendaEvent[]; warnings: string[] };
export const CALENDAR_WINDOW_MS = 60000;
export const CALENDAR_DAY_MS = 86400000;
export const CALENDAR_BODY_LIMIT = 1048576;
export const CALENDAR_EVENT_LIMIT = 2048;
export function calendarText(value: unknown): string | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	return input.version === 1 && typeof input.calendar === 'string' ? input.calendar : null;
}
