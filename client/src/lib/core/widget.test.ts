import { describe, expect, it } from 'vitest';
import {
	BUILTIN_METAS,
	configCompleteness,
	createWidget,
	exprFieldsOf,
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
			'procwatch',
			'netconn',
			'ping',
			'wifi',
			'spectrum',
			'iframe',
			'zone',
			'audioswitch',
			'recyclebin',
			'volume',
			'image',
			'note',
			'spacer',
			'countdown',
			'timer',
			'monitorswitch'
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

	it('seeds defaultCss into the instance when the meta declares it', () => {
		registerMeta({
			type: 'demo.styled',
			label: 'Styled',
			defaultSize: { w: 40, h: 40 },
			defaultCss: '.x { color: red; }'
		});
		const w = createWidget('demo.styled', 's1');
		expect(w.css).toBe('.x { color: red; }');
	});
});

describe('meta.sensors (config → named sensor ids)', () => {
	const sensorsOf = (type: string, config: Record<string, unknown> = {}) => {
		const fn = getMeta(type)?.sensors;
		expect(fn).toBeTypeOf('function');
		return fn!(config);
	};

	it('battery binds the fixed battery.* family', () => {
		expect(sensorsOf('battery')).toEqual({
			percent: 'battery.percent',
			state: 'battery.state',
			time: 'battery.time'
		});
	});

	it('gpu binds the fixed gpu.* family', () => {
		expect(sensorsOf('gpu')).toEqual({
			util: 'gpu.util',
			name: 'gpu.name',
			temp: 'gpu.temp',
			vramUsed: 'gpu.vram.used',
			vramTotal: 'gpu.vram.total',
			power: 'gpu.power',
			clock: 'gpu.clock.core',
			fan: 'gpu.fan'
		});
	});

	it('wifi binds the fixed net.wifi.* family', () => {
		expect(sensorsOf('wifi')).toEqual({
			ssid: 'net.wifi.ssid',
			signal: 'net.wifi.signal',
			rssi: 'net.wifi.rssi',
			rx: 'net.wifi.rx',
			tx: 'net.wifi.tx',
			band: 'net.wifi.band',
			channel: 'net.wifi.channel',
			phy: 'net.wifi.phy'
		});
	});

	it('recyclebin binds the fixed recyclebin.* family', () => {
		expect(sensorsOf('recyclebin')).toEqual({
			items: 'recyclebin.items',
			bytes: 'recyclebin.bytes'
		});
	});

	it('topproc derives proc.<by>.top.* from config.by (default cpu)', () => {
		expect(sensorsOf('topproc')).toEqual({
			name: 'proc.cpu.top.name',
			value: 'proc.cpu.top.pct'
		});
		expect(sensorsOf('topproc', { by: 'mem' })).toEqual({
			name: 'proc.mem.top.name',
			value: 'proc.mem.top.bytes'
		});
	});

	it('procwatch derives proc.watch.<name>.* from config.name (default chrome.exe)', () => {
		expect(sensorsOf('procwatch')).toEqual({
			running: 'proc.watch.chrome.exe.running',
			cpu: 'proc.watch.chrome.exe.cpu',
			mem: 'proc.watch.chrome.exe.mem',
			count: 'proc.watch.chrome.exe.count'
		});
		expect(sensorsOf('procwatch', { name: 'obs64.exe' }).running).toBe(
			'proc.watch.obs64.exe.running'
		);
	});

	it('ping derives net.ping.<host>.* from config.host (default 1.1.1.1)', () => {
		expect(sensorsOf('ping')).toEqual({ ms: 'net.ping.1.1.1.1.ms', up: 'net.ping.1.1.1.1.up' });
		expect(sensorsOf('ping', { host: 'cloudflare.com' })).toEqual({
			ms: 'net.ping.cloudflare.com.ms',
			up: 'net.ping.cloudflare.com.up'
		});
	});
});

describe('exprFieldsOf', () => {
	it('returns [] for an undefined meta', () => {
		expect(exprFieldsOf(undefined)).toEqual([]);
	});

	it('returns [] for a meta with no formula fields', () => {
		expect(exprFieldsOf(getMeta('clock'))).toEqual([]);
	});

	it('extracts expr fields and defaults target to the key', () => {
		// gauge has value (text→number, no target → key), minExpr (target:'min'), maxExpr (target:'max')
		expect(exprFieldsOf(getMeta('gauge'))).toEqual([
			{ key: 'value', result: 'number', target: 'value' },
			{ key: 'minExpr', result: 'number', target: 'min' },
			{ key: 'maxExpr', result: 'number', target: 'max' }
		]);
	});

	it('carries the text result kind (the text meter template)', () => {
		expect(exprFieldsOf(getMeta('text'))).toEqual([
			{ key: 'value', result: 'text', target: 'value' }
		]);
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
