import { describe, expect, it } from 'vitest';
import { appendSample, createTelemetryHub, emptySensorState } from './telemetry';

describe('appendSample', () => {
	it('appends scalar values to history and caps the length', () => {
		let s = emptySensorState();
		for (let i = 0; i < 5; i++) {
			s = appendSample(
				s,
				{ sensor: 'cpu.total', ts_ms: i, value: { kind: 'scalar', value: i } },
				3
			);
		}
		expect(s.history).toEqual([2, 3, 4]);
		expect(s.value).toEqual({ kind: 'scalar', value: 4 });
	});

	it('keeps the latest value but not history for non-numeric samples', () => {
		const s = appendSample(
			emptySensorState(),
			{ sensor: 'clock', ts_ms: 1, value: { kind: 'text', value: 'hi' } },
			10
		);
		expect(s.history).toEqual([]);
		expect(s.value).toEqual({ kind: 'text', value: 'hi' });
	});

	it('tracks the last point of a series', () => {
		const s = appendSample(
			emptySensorState(),
			{ sensor: 'cpu.cores', ts_ms: 1, value: { kind: 'series', value: [1, 2, 3] } },
			10
		);
		expect(s.history).toEqual([3]);
	});

	it('keeps history ordered by ts_ms when samples arrive out of order (backfill)', () => {
		let s = emptySensorState();
		for (const t of [3, 1, 2]) {
			s = appendSample(s, { sensor: 'x', ts_ms: t, value: { kind: 'scalar', value: t } }, 10);
		}
		expect(s.history).toEqual([1, 2, 3]);
		expect(s.historyTs).toEqual([1, 2, 3]);
		// `value` stays the most-recently-INGESTED sample (live current value), not the latest ts.
		expect(s.value).toEqual({ kind: 'scalar', value: 2 });
	});

	it('merges back-dated backfill ahead of existing live samples, then appends fresh ones', () => {
		let s = emptySensorState();
		s = appendSample(s, { sensor: 'x', ts_ms: 100, value: { kind: 'scalar', value: 5 } }, 10);
		s = appendSample(s, { sensor: 'x', ts_ms: 10, value: { kind: 'scalar', value: 1 } }, 10);
		s = appendSample(s, { sensor: 'x', ts_ms: 20, value: { kind: 'scalar', value: 2 } }, 10);
		s = appendSample(s, { sensor: 'x', ts_ms: 200, value: { kind: 'scalar', value: 9 } }, 10);
		expect(s.history).toEqual([1, 2, 5, 9]);
		expect(s.historyTs).toEqual([10, 20, 100, 200]);
	});

	it('caps to the most-recent-by-ts after ordering', () => {
		let s = emptySensorState();
		for (const t of [5, 4, 3, 2, 1]) {
			s = appendSample(s, { sensor: 'x', ts_ms: t, value: { kind: 'scalar', value: t } }, 3);
		}
		expect(s.history).toEqual([3, 4, 5]);
		expect(s.historyTs).toEqual([3, 4, 5]);
	});
});

describe('createTelemetryHub', () => {
	it('notifies subscribers and exposes per-sensor snapshots', () => {
		const hub = createTelemetryHub(10);
		const obs = hub.sensor('cpu.total');
		let notified = 0;
		const unsub = obs.subscribe(() => notified++);

		hub.ingest({ sensor: 'cpu.total', ts_ms: 1, value: { kind: 'scalar', value: 42 } });
		expect(notified).toBe(1);
		expect(obs.getSnapshot().value).toEqual({ kind: 'scalar', value: 42 });
		expect(obs.getSnapshot().history).toEqual([42]);

		unsub();
		hub.ingest({ sensor: 'cpu.total', ts_ms: 2, value: { kind: 'scalar', value: 7 } });
		expect(notified).toBe(1);
	});

	it('routes a batch and isolates sensors from each other', () => {
		const hub = createTelemetryHub();
		hub.ingestBatch([
			{ sensor: 'a', ts_ms: 1, value: { kind: 'scalar', value: 1 } },
			{ sensor: 'b', ts_ms: 1, value: { kind: 'scalar', value: 2 } }
		]);
		expect(hub.sensor('a').getSnapshot().history).toEqual([1]);
		expect(hub.sensor('b').getSnapshot().history).toEqual([2]);
	});

	it('returns a referentially stable empty snapshot before any sample', () => {
		const obs = createTelemetryHub().sensor('missing');
		expect(obs.getSnapshot()).toBe(obs.getSnapshot());
	});

	it('lists ids of sensors that have emitted a sample', () => {
		const hub = createTelemetryHub();
		expect(hub.sensorIds()).toEqual([]);
		hub.ingestBatch([
			{ sensor: 'cpu.total', ts_ms: 1, value: { kind: 'scalar', value: 1 } },
			{ sensor: 'cpu.core.0', ts_ms: 1, value: { kind: 'scalar', value: 2 } }
		]);
		expect(hub.sensorIds().sort()).toEqual(['cpu.core.0', 'cpu.total']);
		// merely reading a sensor doesn't register it
		hub.sensor('mem.used');
		expect(hub.sensorIds()).not.toContain('mem.used');
	});
});

describe('active-sensor tracking (demand-gating)', () => {
	it('subscribing a new id makes it active and fires onActiveChange once', () => {
		const hub = createTelemetryHub();
		let changes = 0;
		hub.onActiveChange(() => changes++);

		expect(hub.activeSensorIds()).toEqual([]);
		hub.sensor('gpu.util').subscribe(() => undefined);
		expect(hub.activeSensorIds()).toEqual(['gpu.util']);
		expect(changes).toBe(1);
	});

	it('a second subscriber to the same id does not fire onActiveChange', () => {
		const hub = createTelemetryHub();
		let changes = 0;
		hub.onActiveChange(() => changes++);

		hub.sensor('gpu.vram').subscribe(() => undefined);
		expect(changes).toBe(1);
		hub.sensor('gpu.vram').subscribe(() => undefined);
		expect(changes).toBe(1);
		expect(hub.activeSensorIds()).toEqual(['gpu.vram']);
	});

	it('unsubscribing the last listener removes the id and fires onActiveChange', () => {
		const hub = createTelemetryHub();
		let changes = 0;
		hub.onActiveChange(() => changes++);

		const a = hub.sensor('gpu.temp').subscribe(() => undefined);
		const b = hub.sensor('gpu.temp').subscribe(() => undefined);
		expect(changes).toBe(1);

		a(); // one of two listeners gone — still active, no transition
		expect(hub.activeSensorIds()).toEqual(['gpu.temp']);
		expect(changes).toBe(1);

		b(); // last listener gone — 1→0 transition
		expect(hub.activeSensorIds()).toEqual([]);
		expect(changes).toBe(2);
	});

	it('onActiveChange unsubscribe stops further notifications', () => {
		const hub = createTelemetryHub();
		let changes = 0;
		const off = hub.onActiveChange(() => changes++);

		hub.sensor('cpu.total').subscribe(() => undefined);
		expect(changes).toBe(1);
		off();
		hub.sensor('mem.used').subscribe(() => undefined);
		expect(changes).toBe(1);
	});
});
