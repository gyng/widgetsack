import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelemetryHub } from '../core/telemetry';
import type { CalendarResult } from '../core/calendarFeedContract';
import { startAgendaExpansion, AGENDA_CALENDAR, AGENDA_LIST, AGENDA_FEEDBACK } from './expansion';
afterEach(() => vi.restoreAllMocks());
const result: CalendarResult = {
	events: [{ summary: 'Call', start: '2026-10-14T09:00:00Z', allDay: false, location: '' }],
	warnings: []
};
function setup(clock = { now: 1000 }) {
	const hub = createTelemetryHub();
	let tick = () => {};
	const requests: {
		resolve: (result: CalendarResult) => void;
		release: ReturnType<typeof vi.fn>;
	}[] = [];
	const offClock = vi.fn();
	const request = vi.fn(() => {
		let resolve!: (result: CalendarResult) => void;
		const promise = new Promise<CalendarResult>((done) => (resolve = done));
		const release = vi.fn();
		requests.push({ resolve, release });
		return { promise, release };
	});
	const stop = startAgendaExpansion(hub, {
		request,
		now: () => clock.now,
		subscribeClock: (listener) => {
			tick = listener;
			return offClock;
		}
	});
	const raw = (value: unknown) =>
		hub.ingestBatch([{ sensor: AGENDA_CALENDAR, ts_ms: 1, value: { kind: 'json', value } }]);
	const read = (id: string) => hub.sensor(id).getSnapshot().value;
	return { hub, requests, request, stop, raw, read, offClock, tick: () => tick() };
}
describe('calendar source expansion', () => {
	it('starts only for list demand and publishes a compatible event array and feedback', async () => {
		const f = setup();
		f.raw({ version: 1, calendar: 'feed' });
		expect(f.request).not.toHaveBeenCalled();
		const off = f.hub.sensor(AGENDA_LIST).subscribe(() => {});
		expect(f.read(AGENDA_FEEDBACK)).toMatchObject({ value: { pending: true } });
		f.requests[0].resolve(result);
		await Promise.resolve();
		expect(f.read(AGENDA_LIST)).toEqual({ kind: 'json', value: result.events });
		f.tick();
		expect(f.requests).toHaveLength(2);
		expect(f.read(AGENDA_FEEDBACK)).toMatchObject({ value: { pending: false } });
		off();
		expect(f.offClock).toHaveBeenCalledTimes(1);
		expect(f.hub.activeSensorIds()).toEqual([]);
		expect(f.requests[1].release).toHaveBeenCalledTimes(1);
		f.stop();
		f.stop();
		f.tick();
		expect(f.requests).toHaveLength(2);
	});
	it('rejects old replies after a source change, loss of demand, or disposal', async () => {
		const f = setup();
		const off = f.hub.sensor(AGENDA_LIST).subscribe(() => {});
		expect(f.request).not.toHaveBeenCalled();
		f.raw({ version: 1, calendar: 'old' });
		f.raw({ version: 1, calendar: 'new' });
		f.requests[0].resolve(result);
		await Promise.resolve();
		expect(f.read(AGENDA_LIST)).toMatchObject({ value: [] });
		off();
		f.requests[1].resolve(result);
		await Promise.resolve();
		expect(f.read(AGENDA_LIST)).toMatchObject({ value: [] });
		const next = f.hub.sensor(AGENDA_LIST).subscribe(() => {});
		f.stop();
		f.requests[2].resolve(result);
		await Promise.resolve();
		expect(f.read(AGENDA_LIST)).toMatchObject({ value: [] });
		next();
	});
	it('preserves legacy arrays and clears unsupported calendar payloads with an error', () => {
		const f = setup();
		f.hub.ingestBatch([
			{ sensor: AGENDA_LIST, ts_ms: 1, value: { kind: 'json', value: result.events } }
		]);
		const off = f.hub.sensor(AGENDA_LIST).subscribe(() => {});
		expect(f.read(AGENDA_LIST)).toMatchObject({ value: result.events });
		f.raw({ version: 2, calendar: 'invalid' });
		f.hub.ingestBatch([
			{ sensor: AGENDA_CALENDAR, ts_ms: 2, value: { kind: 'text', value: 'invalid' } }
		]);
		expect(f.read(AGENDA_LIST)).toMatchObject({ value: [] });
		expect(f.read(AGENDA_FEEDBACK)).toMatchObject({
			value: { warnings: ['Calendar data could not be read.'] }
		});
		off();
		f.stop();
	});
	it('keeps the shown events across jittered minute ticks and blanks only after a real time jump', async () => {
		const clock = { now: 1000 };
		const f = setup(clock);
		f.raw({ version: 1, calendar: 'feed' });
		const off = f.hub.sensor(AGENDA_LIST).subscribe(() => {});
		f.requests[0].resolve(result);
		await Promise.resolve();
		// Minute-aligned ticks land at or a little past 60 s apart; none may flash "Loading…".
		for (const [index, step] of [60_000, 60_017, 59_990, 60_250].entries()) {
			clock.now += step;
			f.tick();
			expect(f.read(AGENDA_LIST)).toEqual({ kind: 'json', value: result.events });
			expect(f.read(AGENDA_FEEDBACK)).toMatchObject({ value: { pending: false } });
			f.requests[index + 1].resolve(result);
			await Promise.resolve();
		}
		// A sleep/resume jump means the shown agenda is stale: clear it until the new result lands.
		clock.now += 3_600_000;
		f.tick();
		expect(f.read(AGENDA_LIST)).toEqual({ kind: 'json', value: [] });
		expect(f.read(AGENDA_FEEDBACK)).toMatchObject({ value: { pending: true } });
		off();
		f.stop();
	});
});
