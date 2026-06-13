import { describe, expect, it } from 'vitest';
import {
	BUILTIN_METAS,
	configCompleteness,
	createWidget,
	getMeta,
	listMetas,
	registerMeta
} from './widget';

describe('createWidget (registry-driven)', () => {
	it('builds a sensor-bound gauge with the built-in defaults', () => {
		const w = createWidget('gauge', 'g1');
		expect(w).toMatchObject({ id: 'g1', type: 'gauge', sensor: 'cpu.total' });
		expect(w.config).toMatchObject({ unit: '%', max: 100 });
		expect(w.rect).toMatchObject({ x: 24, y: 24, w: 110, h: 110 });
	});

	it('builds a self-sourcing clock without a sensor', () => {
		const w = createWidget('clock', 'c1');
		expect(w.sensor).toBeUndefined();
		expect(w.config).toHaveProperty('format');
	});

	it('builds an interactive button', () => {
		const w = createWidget('button', 'b1');
		expect(w.type).toBe('button');
		expect(w.interactive).toBe(true);
	});

	it('falls back to a generic widget for unknown types', () => {
		const w = createWidget('mystery', 'm1');
		expect(w).toMatchObject({ id: 'm1', type: 'mystery', config: {} });
		expect(w.rect.w).toBeGreaterThan(0);
		expect(w.sensor).toBeUndefined();
	});

	it('does not alias the default config across instances', () => {
		const a = createWidget('gauge', 'a');
		const b = createWidget('gauge', 'b');
		(a.config as { unit: string }).unit = 'X';
		expect((b.config as { unit: string }).unit).toBe('%');
	});
});

describe('meta registry', () => {
	it('lists the built-ins with labels + bind kinds', () => {
		const types = listMetas().map((m) => m.type);
		expect(types).toEqual([
			'gauge',
			'bar',
			'sparkline',
			'text',
			'clock',
			'calendar',
			'analogclock',
			'button',
			'cpu',
			'battery',
			'gpu',
			'disks',
			'topproc',
			'netconn',
			'ping',
			'wifi',
			'spectrum',
			'iframe',
			'zone',
			'audioswitch',
			'recyclebin',
			'volume',
			'spacer',
			'countdown',
			'timer'
		]);
		expect(getMeta('gauge')).toMatchObject({ label: 'Gauge', binds: 'scalar' });
		expect(getMeta('sparkline')?.binds).toBe('series');
		expect(getMeta('clock')?.binds).toBe('none');
		expect(getMeta('calendar')).toMatchObject({ label: 'Calendar', binds: 'none' });
		expect(getMeta('analogclock')).toMatchObject({ label: 'Analog Clock', binds: 'none' });
		expect(getMeta('cpu')?.binds).toBe('none');
		expect(getMeta('spectrum')).toMatchObject({ label: 'Spectrum', binds: 'none' });
		expect(getMeta('iframe')).toMatchObject({
			label: 'Web Frame',
			binds: 'none',
			interactive: true
		});
		expect(getMeta('spacer')).toMatchObject({ label: 'Spacer', binds: 'none' });
	});

	it('a registered plugin meta drives createWidget', () => {
		registerMeta({
			type: 'demo.widget',
			label: 'Demo',
			defaultSensor: 'demo.x',
			defaultSize: { w: 50, h: 60 },
			defaultConfig: { k: 1 }
		});
		const w = createWidget('demo.widget', 'd1');
		expect(w).toMatchObject({ type: 'demo.widget', sensor: 'demo.x', config: { k: 1 } });
		expect(w.rect).toMatchObject({ w: 50, h: 60 });
	});
});

describe('configCompleteness (UI-driven config guard)', () => {
	it('every built-in widget exposes a config field for each default-config key', () => {
		// No built-in config should be reachable only via the raw-JSON escape hatch.
		for (const meta of BUILTIN_METAS) {
			expect({ type: meta.type, missing: configCompleteness(meta) }).toEqual({
				type: meta.type,
				missing: []
			});
		}
	});

	it('reports default-config keys that have no field', () => {
		expect(
			configCompleteness({
				type: 't',
				defaultConfig: { a: 1, b: 2 },
				configFields: [{ key: 'a', label: 'a', kind: 'number' }]
			})
		).toEqual(['b']);
	});

	it('treats a field default as independent of defaultConfig (a field with no default-config key still counts)', () => {
		expect(
			configCompleteness({
				type: 't',
				defaultConfig: { a: 1 },
				configFields: [
					{ key: 'a', label: 'a', kind: 'number' },
					{ key: 'extra', label: 'extra', kind: 'text', default: 'x' }
				]
			})
		).toEqual([]);
	});
});
