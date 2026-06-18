import { describe, expect, it, vi } from 'vitest';
import { createTelemetryHub } from '../../core/telemetry';

// Mock the Tauri command adapter so the orchestration test stays I/O-free.
const haHistory = vi.fn();
vi.mock('./ha-commands', () => ({ haHistory: (...a: unknown[]) => haHistory(...a) }));

import { haEntityForHistory, startHaBackfill } from './ha-backfill';

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
});
