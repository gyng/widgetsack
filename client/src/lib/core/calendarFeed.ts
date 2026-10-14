import ICAL from 'ical.js';
import type { AgendaEvent } from './agenda';
import { browserTimezone, calendarOffsetSeconds } from './calendarTimezone';
import { normalizeCalendarDates } from './calendarDates';

import {
	CALENDAR_DAY_MS,
	CALENDAR_BODY_LIMIT,
	CALENDAR_EVENT_LIMIT,
	type CalendarResult
} from './calendarFeedContract';
export type { CalendarResult } from './calendarFeedContract';
type CalendarLimits = { horizonDays?: number; maxEvents?: number; maxIterations?: number };
type CalendarEvent = InstanceType<typeof ICAL.Event>;
type CalendarTime = InstanceType<typeof ICAL.Time>;
type Candidate = { key: string; event: AgendaEvent; ms: number };
const ITERATION_LIMIT = Symbol('calendar iteration limit');

const text = (component: InstanceType<typeof ICAL.Component>, property: string): string => {
	const value = component.getFirstPropertyValue(property);
	return typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ') : '';
};
const cancelled = (event: CalendarEvent) =>
	text(event.component, 'status').toUpperCase() === 'CANCELLED';
const identity = (time: CalendarTime): string =>
	time.isDate ? time.toString() : String(time.toUnixTime());
const revision = (event: CalendarEvent): [number, string] => {
	const value = event.component.getFirstPropertyValue('sequence');
	const stamp = event.component.getFirstPropertyValue('dtstamp');
	return [
		typeof value === 'number' ? value : 0,
		stamp instanceof ICAL.Time ? stamp.toString() : ''
	];
};
const newer = (a: CalendarEvent, b: CalendarEvent) => {
	const [sequenceA, stampA] = revision(a),
		[sequenceB, stampB] = revision(b);
	return sequenceA > sequenceB || (sequenceA === sequenceB && stampA >= stampB);
};

/** Expand an ICS snapshot in a worker. Input size, output, and iteration budgets are bounded.
 * Non-repeating future events are retained even beyond the recurrence horizon. */
export function expandCalendar(
	calendar: string,
	now: number,
	limits: CalendarLimits = {}
): CalendarResult {
	const warnings = new Set<string>();
	const candidates: Candidate[] = [];
	const keys = new Set<string>();
	const patterns = new Map<string, CalendarTime[]>();
	const lower = now - 3600000;
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const upper = now + (limits.horizonDays ?? 366) * CALENDAR_DAY_MS;
	const maxEvents = limits.maxEvents ?? CALENDAR_EVENT_LIMIT;
	const maxIterations = limits.maxIterations ?? 250000;
	const unreadable = () => warnings.add('Some calendar events could not be read.');
	const emit = (
		event: CalendarEvent,
		time: CalendarTime,
		key: string,
		master = event,
		bounded = false
	) => {
		if (!(time instanceof ICAL.Time)) throw new Error('Missing event start');
		const ms = time.toJSDate().getTime();
		/* v8 ignore next -- temporal fields are validated before hydration; iterator/date overflow
		 * throws before this seam (covered by the overflow regression). Keep this safety backstop. */
		if (!Number.isFinite(ms)) throw new Error('Invalid event start');
		if (
			ms < (time.isDate ? today.getTime() : lower) ||
			(bounded && ms > upper) ||
			keys.has(key) ||
			cancelled(event)
		)
			return;
		const summary = event.component.hasProperty('summary')
			? text(event.component, 'summary')
			: text(master.component, 'summary');
		if (!summary) {
			unreadable();
			return;
		}
		const row: AgendaEvent = {
			id: key,
			summary,
			start: time.isDate ? time.toString() : new Date(ms).toISOString(),
			allDay: time.isDate,
			location: event.component.hasProperty('location')
				? text(event.component, 'location')
				: text(master.component, 'location')
		};
		let lo = 0,
			hi = candidates.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (candidates[mid].ms < ms || (candidates[mid].ms === ms && candidates[mid].key < key))
				lo = mid + 1;
			else hi = mid;
		}
		candidates.splice(lo, 0, { key, event: row, ms });
		keys.add(key);
		if (candidates.length > maxEvents) {
			keys.delete(candidates.pop()!.key);
			warnings.add(`Only the first ${maxEvents} calendar events are shown.`);
		}
	};
	try {
		if (!Number.isFinite(now) || new TextEncoder().encode(calendar).length > CALENDAR_BODY_LIMIT)
			throw new Error('Invalid calendar input');
		const root = ICAL.Component.fromString(calendar);
		if (root.name !== 'vcalendar') throw new Error('Not a calendar');
		if (text(root, 'method').toUpperCase() === 'CANCEL') return { events: [], warnings: [] };
		for (const zone of root.getAllSubcomponents('vtimezone')) {
			try {
				if (!text(zone, 'tzid')) throw new Error('Missing timezone identifier');
				const rules = zone.getAllSubcomponents();
				if (!rules.length) throw new Error('Missing timezone observances');
				for (const rule of rules) {
					if (
						!['standard', 'daylight'].includes(rule.name) ||
						rule.getFirstProperty('dtstart')?.type !== 'date-time'
					)
						throw new Error('Invalid timezone observance');
					normalizeCalendarDates(rule);
					for (const name of ['tzoffsetfrom', 'tzoffsetto']) {
						const property = rule.getFirstProperty(name);
						const seconds = property
							? calendarOffsetSeconds((property.toJSON() as unknown[])[3])
							: null;
						if (seconds === null || property?.type !== 'utc-offset')
							throw new Error('Invalid timezone offset');
						const offset = property.getFirstValue() as InstanceType<typeof ICAL.UtcOffset>;
						offset.factor = seconds < 0 ? -1 : 1;
						offset.hours = Math.floor(Math.abs(seconds) / 3600);
						// ICAL.Timezone reads hours/minutes directly, so retain the fractional minute.
						offset.minutes = (Math.abs(seconds) % 3600) / 60;
					}
				}
			} catch {
				root.removeSubcomponent(zone);
				unreadable();
			}
		}
		const getTimezone = root.getTimeZoneByID.bind(root);
		// A TZID that is neither defined in the feed nor a known IANA zone (e.g. a Windows name)
		// reads as floating time, like an event without a TZID, instead of dropping its events.
		const fallbackTimezone = (tzid: string) => {
			try {
				return browserTimezone(tzid);
			} catch {
				warnings.add('Some calendar times use an unknown timezone and are shown in local time.');
				return ICAL.Timezone.localTimezone;
			}
		};
		const zones = new Map<string, InstanceType<typeof ICAL.Timezone>>();
		root.getTimeZoneByID = (tzid) => {
			let zone = zones.get(tzid);
			if (!zone) {
				zone = getTimezone(tzid) ?? fallbackTimezone(tzid);
				zones.set(tzid, zone);
			}
			return zone;
		};
		const series = new Map<
			string,
			{ master?: CalendarEvent; exceptions: Map<string, CalendarEvent> }
		>();
		root.getAllSubcomponents('vevent').forEach((component, index) => {
			try {
				normalizeCalendarDates(component);
				const event = new ICAL.Event(component, { exceptions: [] });
				if (!cancelled(event) && !event.startDate) throw new Error('Missing event start');
				const identifier = text(component, 'uid');
				const uid = identifier ? `named:${identifier}` : `anonymous:${index}`;
				let entry = series.get(uid);
				if (!entry) {
					entry = { exceptions: new Map() };
					series.set(uid, entry);
				}
				if (event.isRecurrenceException()) {
					const key = identity(event.recurrenceId);
					if (cancelled(event) && !event.startDate) event.startDate = event.recurrenceId.clone();
					const previous = entry.exceptions.get(key);
					if (!previous || newer(event, previous)) entry.exceptions.set(key, event);
				} else if (!entry.master || newer(event, entry.master)) entry.master = event;
			} catch {
				unreadable();
			}
		});
		for (const [uid, { master, exceptions }] of series) {
			try {
				if (master && cancelled(master)) continue;
				let backwardShift = 0;
				let forwardShift = 0;
				for (const [key, exception] of exceptions) {
					if (master) {
						if (exception.modifiesFuture()) {
							const shift =
								exception.startDate.toJSDate().getTime() -
								exception.recurrenceId.toJSDate().getTime();
							backwardShift = Math.max(backwardShift, -shift);
							forwardShift = Math.max(forwardShift, shift);
						} else
							exception.recurrenceId = exception.recurrenceId.convertToZone(
								ICAL.Timezone.utcTimezone
							);
						master.relateException(exception);
					}
					if (!exception.modifiesFuture())
						emit(exception, exception.startDate, `${uid}:${key}`, master);
				}
				if (!master) continue;
				if (!master.isRecurring()) {
					emit(master, master.startDate, `${uid}:single`);
					continue;
				}
				// DTSTART belongs to the recurrence set even when only RDATE supplies additional dates.
				if (!master.component.hasProperty('rrule'))
					master.component.addPropertyWithValue('rdate', master.startDate.clone());
				const windowStart = Math.min(lower, today.getTime()) - forwardShift;
				const windowEnd = upper + backwardShift;
				const pattern = JSON.stringify([
					master.startDate.toString(),
					master.startDate.zone.tzid,
					windowStart,
					windowEnd,
					master.component
						.getAllProperties()
						.filter((property) => ['rrule', 'rdate', 'exdate', 'exrule'].includes(property.name))
						.map((property) => property.toJSON())
				]);
				const occurrences = function* (): Generator<CalendarTime> {
					const cached = patterns.get(pattern);
					if (cached) {
						yield* cached;
						return;
					}
					let steps = 0;
					const saved: CalendarTime[] = [];
					let reusable = true;
					const next = (
						iterator:
							| ReturnType<CalendarEvent['iterator']>
							| ReturnType<InstanceType<typeof ICAL.Recur>['iterator']>
					) => {
						if (++steps > maxIterations) throw ITERATION_LIMIT;
						return iterator.next();
					};
					const exclusions = master.component.getAllProperties('exrule').map((property) => {
						const value = property.getFirstValue();
						const rule = value instanceof ICAL.Recur ? value : ICAL.Recur.fromString(String(value));
						const iterator = rule.iterator(master.startDate);
						return { iterator, occurrence: next(iterator) };
					});
					const iterator = master.iterator();
					for (;;) {
						const occurrence = next(iterator);
						if (!occurrence) break;
						const start = occurrence.toJSDate().getTime();
						if (start > windowEnd) break;
						if (start < windowStart) continue;
						let excluded = false;
						for (const exclusion of exclusions) {
							while (exclusion.occurrence && exclusion.occurrence.compare(occurrence) < 0)
								exclusion.occurrence = next(exclusion.iterator);
							if (exclusion.occurrence?.compare(occurrence) === 0) excluded = true;
						}
						if (excluded) continue;
						if (reusable) {
							if (saved.length === 4096) {
								reusable = false;
								saved.length = 0;
							} else saved.push(occurrence.clone());
						}
						yield occurrence;
					}
					if (reusable) {
						if (patterns.size === 8) patterns.delete(patterns.keys().next().value!);
						patterns.set(pattern, saved);
					}
				};
				for (const occurrence of occurrences()) {
					if (
						candidates.length === maxEvents &&
						occurrence.toJSDate().getTime() > candidates.at(-1)!.ms + backwardShift
					) {
						warnings.add(`Only the first ${maxEvents} calendar events are shown.`);
						continue;
					}
					const details = master.getOccurrenceDetails(occurrence);
					emit(details.item, details.startDate, `${uid}:${identity(occurrence)}`, master, true);
				}
			} catch (error) {
				if (error === ITERATION_LIMIT)
					warnings.add('A calendar recurrence exceeded the processing limit.');
				else unreadable();
			}
		}
	} catch {
		warnings.add('The calendar could not be read.');
	}
	return { events: candidates.map((candidate) => candidate.event), warnings: [...warnings] };
}
