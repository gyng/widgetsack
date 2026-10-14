import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTelemetryHub } from '../../core/telemetry';

// Mock the Tauri command adapter so the orchestration test stays I/O-free.
const haHistory = vi.fn();
vi.mock('./ha-commands', () => ({ haHistory: (...a: unknown[]) => haHistory(...a) }));

import {
	HA_BACKFILL_MAX_RETRY_MS,
	HA_BACKFILL_RETRY_MS,
	haEntityForHistory,
	startHaBackfill
} from './ha-backfill';

// The mock is module-level (shared across tests); reset its call log so each test asserts
// absolute call counts from a clean baseline.
beforeEach(() => haHistory.mockReset());

describe('haEntityForHistory', () => {
	it('maps a numeric .state id to its entity_id', () => {
		expect(haEntityForHistory('ha.sensor.temp.state')).toBe('sensor.temp');
		expect(haEntityForHistory('ha.binary_sensor.front_door.state')).toBe(
			'binary_sensor.front_door'
		);
	});

	it('ignores non-history ids', () => {
		expect(haEntityForHistory('ha.sensor.temp')).toBeNull(); // json id, no history
		expect(haEntityForHistory('ha.status')).toBeNull(); // connection sensor (no entity dot)
		expect(haEntityForHistory('cpu.total')).toBeNull(); // not HA
		expect(haEntityForHistory('ha.power_state')).toBeNull(); // single-part, not <domain>.<obj>
	});

	it('does not mis-strip an entity whose object id merely ends in "state"', () => {
		// 'ha.sensor.power_state' is a JSON id (no '.state' suffix) → ignored, not '.state' scalar
		expect(haEntityForHistory('ha.sensor.power_state')).toBeNull();
	});

	it('ignores a .state id whose stripped entity has no domain dot', () => {
		// Passes the ha./.state guard, but 'status' (between them) has no '<domain>.<object_id>' dot.
		expect(haEntityForHistory('ha.status.state')).toBeNull();
	});
});

describe('startHaBackfill', () => {
	it('backfills each active HA entity once when it gains a subscriber', async () => {
		haHistory.mockResolvedValue([]);
		const hub = createTelemetryHub();
		const stop = startHaBackfill(hub);

		// A sparkline subscribes to a numeric HA sensor → triggers one backfill.
		hub.sensor('ha.sensor.temp.state').subscribe(() => undefined);
		expect(haHistory).toHaveBeenCalledTimes(1);
		expect(haHistory.mock.calls[0][0]).toBe('sensor.temp');

		// A second subscriber to the same entity does not re-fetch.
		hub.sensor('ha.sensor.temp.state').subscribe(() => undefined);
		expect(haHistory).toHaveBeenCalledTimes(1);

		// A different entity triggers another backfill; a non-history id does not.
		hub.sensor('ha.sensor.power.state').subscribe(() => undefined);
		hub.sensor('ha.light.kitchen').subscribe(() => undefined);
		expect(haHistory).toHaveBeenCalledTimes(2);

		stop();
	});

	it('ingests returned samples into the hub', async () => {
		haHistory.mockResolvedValue([
			{ sensor: 'ha.sensor.temp.state', ts_ms: 1000, value: { kind: 'scalar', value: 21 } },
			{ sensor: 'ha.sensor.temp.state', ts_ms: 2000, value: { kind: 'scalar', value: 22 } }
		]);
		const hub = createTelemetryHub();
		startHaBackfill(hub);
		hub.sensor('ha.sensor.temp.state').subscribe(() => undefined);
		// let the backfill promise resolve
		await Promise.resolve();
		await Promise.resolve();
		expect(hub.sensor('ha.sensor.temp.state').getSnapshot().history).toEqual([21, 22]);
	});

	it('does not ingest when the history is empty (no samples to merge)', async () => {
		haHistory.mockResolvedValue([]);
		const hub = createTelemetryHub();
		const ingest = vi.spyOn(hub, 'ingestBatch');
		startHaBackfill(hub);
		hub.sensor('ha.sensor.temp.state').subscribe(() => undefined);
		await Promise.resolve();
		await Promise.resolve();
		expect(ingest).not.toHaveBeenCalled();
	});

	it('warns and retries a failed entity only after a growing backoff', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(0);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		// Every sensor.temp fetch rejects (HA unconfigured / unreachable); siblings succeed empty.
		haHistory.mockImplementation((entity: string) =>
			entity === 'sensor.temp' ? Promise.reject(new Error('HA down')) : Promise.resolve([])
		);
		const hub = createTelemetryHub();
		startHaBackfill(hub);
		const tempCalls = (): number =>
			haHistory.mock.calls.filter((c) => c[0] === 'sensor.temp').length;
		const settle = async (): Promise<void> => {
			await Promise.resolve();
			await Promise.resolve();
		};
		let n = 0;
		const tick = (): void => {
			hub.sensor(`ha.sensor.other${n++}.state`).subscribe(() => undefined);
		};

		hub.sensor('ha.sensor.temp.state').subscribe(() => undefined);
		await settle();
		expect(tempCalls()).toBe(1);
		expect(warn).toHaveBeenCalledWith(
			'HA history backfill failed for',
			'sensor.temp',
			expect.any(Error)
		);

		// Active-set churn inside the backoff window does not re-fetch (or re-warn).
		tick();
		vi.setSystemTime(HA_BACKFILL_RETRY_MS - 1);
		tick();
		expect(tempCalls()).toBe(1);

		// Once the window passes, the next tick retries…
		vi.setSystemTime(HA_BACKFILL_RETRY_MS);
		tick();
		expect(tempCalls()).toBe(2);
		await settle();

		// …and a second failure doubles the wait.
		vi.setSystemTime(HA_BACKFILL_RETRY_MS * 2);
		tick();
		expect(tempCalls()).toBe(2);
		vi.setSystemTime(HA_BACKFILL_RETRY_MS * 3);
		tick();
		expect(tempCalls()).toBe(3);
		await settle();

		warn.mockRestore();
		vi.useRealTimers();
	});

	it('caps the backoff and clears it once a retry succeeds', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(0);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		let fail = true;
		haHistory.mockImplementation((entity: string) =>
			entity === 'sensor.temp' && fail ? Promise.reject(new Error('HA down')) : Promise.resolve([])
		);
		const hub = createTelemetryHub();
		startHaBackfill(hub);
		const tempCalls = (): number =>
			haHistory.mock.calls.filter((c) => c[0] === 'sensor.temp').length;
		let n = 0;
		const tickAt = async (t: number): Promise<void> => {
			vi.setSystemTime(t);
			hub.sensor(`ha.sensor.other${n++}.state`).subscribe(() => undefined);
			await Promise.resolve();
			await Promise.resolve();
		};

		hub.sensor('ha.sensor.temp.state').subscribe(() => undefined);
		await tickAt(0);
		// Fail repeatedly, always retrying at the cap; the wait never exceeds HA_BACKFILL_MAX_RETRY_MS.
		let now = 0;
		for (let i = 0; i < 10; i++) {
			now += HA_BACKFILL_MAX_RETRY_MS;
			await tickAt(now);
		}
		expect(tempCalls()).toBe(11);

		// A retry that succeeds marks the entity done for good.
		fail = false;
		now += HA_BACKFILL_MAX_RETRY_MS;
		await tickAt(now);
		expect(tempCalls()).toBe(12);
		await tickAt(now * 10);
		expect(tempCalls()).toBe(12);

		warn.mockRestore();
		vi.useRealTimers();
	});
});
