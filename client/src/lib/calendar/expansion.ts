import type { TelemetryHub } from '../core/telemetry';
import {
	CALENDAR_WINDOW_MS,
	calendarText,
	type CalendarResult
} from '../core/calendarFeedContract';
import type { CalendarRequest } from './processor';
export const AGENDA_CALENDAR = 'agenda.calendar';
export const AGENDA_LIST = 'agenda.list';
export const AGENDA_FEEDBACK = 'agenda.parse';
const STALE_AFTER_MS = 2 * CALENDAR_WINDOW_MS;
type ExpansionDeps = {
	request: (calendar: string, now: number) => CalendarRequest;
	subscribeClock: (listener: () => void) => () => void;
	now: () => number;
};

/** Keep the public JSON event-array sensor compatible. Expand the internal calendar only
 * while a list consumer is mounted. Local teardown never disconnects the backend worker. */
export function startAgendaExpansion(hub: TelemetryHub, deps: ExpansionDeps): () => void {
	let active = false,
		disposed = false,
		revision = 0;
	let offRaw: (() => void) | null = null,
		offClock: (() => void) | null = null;
	let release: (() => void) | null = null;
	let applied: string | null = null;
	let appliedAt = -Infinity;
	const feedback = (pending: boolean, warnings: string[]) =>
		hub.ingestBatch([
			{
				sensor: AGENDA_FEEDBACK,
				ts_ms: deps.now(),
				value: { kind: 'json', value: { pending, warnings } }
			}
		]);
	const stopRequest = () => {
		revision++;
		release?.();
		release = null;
	};
	const refresh = () => {
		if (disposed || !active) return;
		stopRequest();
		const raw = hub.sensor(AGENDA_CALENDAR).getSnapshot().value;
		if (!raw) return; // Legacy/demo arrays need no expansion.
		const calendar = calendarText(raw.kind === 'json' ? raw.value : null);
		if (calendar === null) {
			hub.ingestBatch([
				{ sensor: AGENDA_LIST, ts_ms: deps.now(), value: { kind: 'json', value: [] } }
			]);
			feedback(false, ['Calendar data could not be read.']);
			return;
		}
		const captured = revision;
		const at = deps.now();
		// Minute ticks arrive a window apart plus timer jitter: keep the shown events until the new
		// result replaces them, and only clear for a new source or a real time jump (sleep/resume).
		if (applied !== calendar || Math.abs(at - appliedAt) > STALE_AFTER_MS) {
			hub.ingestBatch([{ sensor: AGENDA_LIST, ts_ms: at, value: { kind: 'json', value: [] } }]);
			feedback(true, []);
		}
		const request = deps.request(calendar, at);
		release = request.release;
		void request.promise.then((result: CalendarResult) => {
			if (disposed || !active || captured !== revision) return;
			applied = calendar;
			appliedAt = at;
			hub.ingestBatch([
				{ sensor: AGENDA_LIST, ts_ms: deps.now(), value: { kind: 'json', value: result.events } },
				{
					sensor: AGENDA_FEEDBACK,
					ts_ms: deps.now(),
					value: { kind: 'json', value: { pending: false, warnings: result.warnings } }
				}
			]);
		});
	};
	const demand = () => {
		const wanted = hub.activeSensorIds().includes(AGENDA_LIST);
		if (wanted === active || disposed) return;
		active = wanted;
		if (active) {
			offRaw = hub.sensor(AGENDA_CALENDAR).subscribe(refresh);
			offClock = deps.subscribeClock(refresh);
			refresh();
		} else {
			offRaw?.();
			offRaw = null;
			offClock?.();
			offClock = null;
			stopRequest();
		}
	};
	const offDemand = hub.onActiveChange(demand);
	demand();
	return () => {
		if (disposed) return;
		disposed = true;
		active = false;
		offDemand();
		offRaw?.();
		offClock?.();
		stopRequest();
	};
}
