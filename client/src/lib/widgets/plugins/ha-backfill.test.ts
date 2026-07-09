import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTelemetryHub } from '../../core/telemetry';

// Mock the Tauri command adapter so the orchestration test stays I/O-free.
const haHistory = vi.fn();
vi.mock('./ha-commands', () => ({ haHistory: (...a: unknown[]) => haHistory(...a) }));

import { haEntityForHistory, startHaBackfill } from './ha-backfill';

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

	it('warns and releases the claim on a failed fetch so a later tick can retry', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		// First fetch rejects (HA blip at mount); every later fetch (the retry + other entities) is
		// an empty success so the test produces no unhandled rejections.
		haHistory.mockResolvedValue([]).mockRejectedValueOnce(new Error('HA blip'));
		const hub = createTelemetryHub();
		startHaBackfill(hub);

		hub.sensor('ha.sensor.temp.state').subscribe(() => undefined);
		expect(haHistory).toHaveBeenCalledTimes(1);
		// Let the rejected backfill settle so the entity's claim is released.
		await Promise.resolve();
		await Promise.resolve();
		expect(warn).toHaveBeenCalledWith(
			'HA history backfill failed for',
			'sensor.temp',
			expect.any(Error)
		);

		// A later active-change tick (another sensor mounts) retries the still-unfilled entity.
		hub.sensor('ha.sensor.other.state').subscribe(() => undefined);
		expect(haHistory.mock.calls.filter((c) => c[0] === 'sensor.temp')).toHaveLength(2);
		// Let the retry + sibling fetch settle before restoring the console spy.
		await Promise.resolve();
		await Promise.resolve();

		warn.mockRestore();
	});
});
