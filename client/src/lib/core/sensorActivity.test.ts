import { describe, expect, it } from 'vitest';
import {
	collectSensorRefs,
	isAlwaysOnSensor,
	sensorActivity,
	type SensorRef
} from './sensorActivity';
import { container, group, leaf, type Library, type MonitorLayout } from './layoutTree';

const inst = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
	id,
	type,
	rect: { x: 0, y: 0, w: 10, h: 10 },
	config: {},
	...extra
});

describe('isAlwaysOnSensor (mirrors sensors.rs gating)', () => {
	it('cheap system sensors are always-on', () => {
		for (const id of [
			'cpu.total',
			'cpu.core.5',
			'mem.used',
			'mem.total',
			'swap.used',
			'net.down',
			'host.uptime',
			'host.idle',
			'battery.percent'
		]) {
			expect(isAlwaysOnSensor(id)).toBe(true);
		}
	});

	it('demand-gated system sensors are NOT always-on', () => {
		for (const id of [
			'gpu.util',
			'gpu.temp',
			'cpu.freq',
			'cpu.freq.current',
			'cpu.core.3.freq',
			'mem.commit.used',
			'mem.cached',
			'host.procs',
			'host.handles',
			'disk.c.total',
			'disk.c.read',
			'net.linkspeed.rx',
			'net.adapter',
			'proc.cpu.top.pct'
		]) {
			expect(isAlwaysOnSensor(id)).toBe(false);
		}
	});

	it('plugin sensors are not classified as always-on (survive close only if referenced)', () => {
		expect(isAlwaysOnSensor('ha.light.kitchen')).toBe(false);
		expect(isAlwaysOnSensor('stock.AAPL.price')).toBe(false);
	});
});

describe('collectSensorRefs', () => {
	const layout: MonitorLayout = {
		root: container('root', 'col', [
			leaf(inst('g', 'gauge', { sensor: 'gpu.util' })),
			leaf(inst('t', 'text', { config: { value: '{bytes(mem.used.bytes)} · {gpu.temp}°' } }))
		]),
		floating: []
	};
	const refs = collectSensorRefs([{ key: 'default', layout }]);

	it('records a bound sensor with its widget', () => {
		expect(refs.get('gpu.util')).toMatchObject([
			{ widgetType: 'gauge', widgetId: 'g', monitorKey: 'default', via: 'bound' }
		]);
	});

	it('records formula/template references', () => {
		expect(refs.get('mem.used.bytes')?.[0]).toMatchObject({ widgetType: 'text', via: 'formula' });
		expect(refs.get('gpu.temp')?.[0].via).toBe('formula');
	});

	it('ignores a widget whose bound sensor is the empty string', () => {
		// An empty bound `sensor` is treated as "no sensor" (the `if (inst.sensor)` guard in visit),
		// so it contributes nothing.
		const ml: MonitorLayout = {
			root: container('r', 'col', [leaf(inst('g', 'gauge', { sensor: '' }))]),
			floating: []
		};
		expect(collectSensorRefs([{ key: 'default', layout: ml }]).size).toBe(0);
	});

	it('accumulates multiple widgets that reference the same sensor', () => {
		const ml: MonitorLayout = {
			root: container('r', 'col', [
				leaf(inst('a', 'gauge', { sensor: 'cpu.total' })),
				leaf(inst('b', 'bar', { sensor: 'cpu.total' }))
			]),
			floating: []
		};
		const r = collectSensorRefs([{ key: 'default', layout: ml }]);
		expect(r.get('cpu.total')).toHaveLength(2);
		expect(r.get('cpu.total')?.map((x) => x.widgetId)).toEqual(['a', 'b']);
	});

	it('extracts refs from a NUMBER-result expr field (not just text templates)', () => {
		// gauge's `value` field is kind:'expr', result:'number' → exprRefs(), not templateRefs().
		const ml: MonitorLayout = {
			root: container('r', 'col', [
				leaf(inst('g', 'gauge', { config: { value: 'round(gpu.power) + cpu.total' } }))
			]),
			floating: []
		};
		const r = collectSensorRefs([{ key: 'default', layout: ml }]);
		expect(r.get('gpu.power')?.[0]).toMatchObject({ widgetType: 'gauge', via: 'formula' });
		expect(r.get('cpu.total')?.[0].via).toBe('formula');
	});

	it('ignores a non-string or empty expr config value', () => {
		const ml: MonitorLayout = {
			root: container('r', 'col', [
				leaf(inst('g1', 'gauge', { config: { value: 42 } })), // non-string → skipped
				leaf(inst('g2', 'gauge', { config: { value: '' } })) // empty string → skipped
			]),
			floating: []
		};
		expect(collectSensorRefs([{ key: 'default', layout: ml }]).size).toBe(0);
	});

	it('walks a floating leaf', () => {
		const ml: MonitorLayout = {
			root: container('r', 'col', []),
			floating: [leaf(inst('f', 'gauge', { sensor: 'gpu.util' }))]
		};
		const r = collectSensorRefs([{ key: 'm', layout: ml }]);
		expect(r.get('gpu.util')?.[0]).toMatchObject({ widgetId: 'f', monitorKey: 'm', via: 'bound' });
	});

	it('descends into an inline-child group leaf', () => {
		const inner = container('gi', 'col', [leaf(inst('w', 'gauge', { sensor: 'disk.c.read' }))]);
		const ml: MonitorLayout = {
			root: container('r', 'col', [leaf(group('grp', { w: 100, h: 60 }, inner))]),
			floating: []
		};
		const r = collectSensorRefs([{ key: 'default', layout: ml }]);
		expect(r.get('disk.c.read')?.[0].widgetId).toBe('w');
	});

	it('resolves a def-backed group through the library', () => {
		const def = {
			id: 'def1',
			name: 'Disk',
			size: { w: 100, h: 60 },
			child: container('dc', 'col', [leaf(inst('dw', 'gauge', { sensor: 'gpu.temp' }))])
		};
		const library: Library = { version: 1, defs: [def] };
		const ml: MonitorLayout = {
			root: container('r', 'col', [
				leaf(group('grp', { w: 100, h: 60 }, container('placeholder', 'col', []), { def: 'def1' }))
			]),
			floating: []
		};
		const r = collectSensorRefs([{ key: 'default', layout: ml }], library);
		expect(r.get('gpu.temp')?.[0].widgetId).toBe('dw');
	});

	it('safely handles a def-backed group whose def is missing from the library (no child)', () => {
		const ml: MonitorLayout = {
			root: container('r', 'col', [
				leaf(group('grp', { w: 100, h: 60 }, container('placeholder', 'col', []), { def: 'ghost' }))
			]),
			floating: []
		};
		// def 'ghost' not in the (empty) library → child undefined → nothing collected, no throw.
		expect(collectSensorRefs([{ key: 'default', layout: ml }], { version: 1, defs: [] }).size).toBe(
			0
		);
	});
});

describe('sensorActivity', () => {
	it('referenced → active + names the widgets (the why)', () => {
		const a = sensorActivity('gpu.util', [
			{ widgetType: 'gauge', widgetId: 'g', monitorKey: 'default', via: 'bound' }
		]);
		expect(a).toMatchObject({ active: true, referenced: true });
		expect(a.reason).toContain('gauge');
	});

	it('unreferenced cheap sensor → still active (always sampled)', () => {
		expect(sensorActivity('cpu.total', undefined)).toMatchObject({
			active: true,
			referenced: false
		});
	});

	it('unreferenced gated/plugin sensor → stops on close', () => {
		expect(sensorActivity('gpu.temp', undefined).active).toBe(false);
		expect(sensorActivity('ha.light.x', undefined).active).toBe(false);
	});

	it('treats an empty refs array as unreferenced (falls through to the always-on / stops check)', () => {
		// refs is defined but length 0 → the `refs.length` guard is false.
		expect(sensorActivity('cpu.total', []).referenced).toBe(false);
		expect(sensorActivity('gpu.temp', []).active).toBe(false);
	});

	it('de-duplicates repeated widget labels in the reason (formula labelled distinctly)', () => {
		const refs: SensorRef[] = [
			{ widgetType: 'gauge', widgetId: 'a', monitorKey: 'm', via: 'bound' },
			{ widgetType: 'gauge', widgetId: 'b', monitorKey: 'm', via: 'bound' }, // dupe label → skipped
			{ widgetType: 'gauge', widgetId: 'c', monitorKey: 'm', via: 'formula' } // distinct label
		];
		const a = sensorActivity('cpu.total', refs);
		expect(a.reason).toBe('used by gauge, gauge (formula)');
	});
});
