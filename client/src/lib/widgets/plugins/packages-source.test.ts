import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// End-to-end tick pipeline against the REAL QuickJS sandbox (the engine's WASM harness runs fine
// under vitest — see formula/engine.test.ts); only the Tauri command module is stubbed.
const assets = new Map<string, string>();
const fetches: { id: string; url: string }[] = [];
let fetchImpl: (id: string, url: string) => Promise<{ url: string; status: number; body: string }>;

vi.mock('./packages-commands', () => ({
	readPluginPackageAsset: (id: string, name: string) => Promise.resolve(assets.get(name) ?? null),
	packageFetch: (id: string, url: string) => {
		fetches.push({ id, url });
		return fetchImpl(id, url);
	}
}));

import type { PluginPackageManifest } from '../../core/pluginPackage';
import { createTelemetryHub } from '../../core/telemetry';
import { startPackageSource } from './packages-source';

const manifest = (over: Partial<PluginPackageManifest> = {}): PluginPackageManifest => ({
	manifestVersion: 1,
	id: 'wx',
	name: 'Weather',
	version: '1.0.0',
	templates: [],
	source: { file: 'source.js', pollSeconds: 60, hosts: ['api.example.com'] },
	sensors: [
		{ id: 'temp', label: 'Temperature', unit: '°C' },
		{ id: 'summary', label: 'Summary' }
	],
	...over
});

const SOURCE_JS = `
module.exports = {
	requests: function () {
		return ['https://api.example.com/now'];
	},
	transform: function (responses) {
		var r = responses[0];
		if (!r || r.status !== 200) return [{ sensor: 'summary', value: 'offline' }];
		var data = JSON.parse(r.body);
		return [
			{ sensor: 'temp', value: data.t },
			{ sensor: 'summary', value: data.text },
			{ sensor: 'undeclared', value: 1 }
		];
	}
};
`;

// Wait until `pred` holds (the first tick runs async behind startPackageSource).
async function until(pred: () => boolean): Promise<void> {
	for (let i = 0; i < 300 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
	expect(pred()).toBe(true);
}

const textOf = (hub: ReturnType<typeof createTelemetryHub>, id: string): string | null => {
	const v = hub.sensor(id).getSnapshot().value;
	return v?.kind === 'text' ? v.value : null;
};

describe('startPackageSource', () => {
	let stop: (() => void) | null = null;
	beforeEach(() => {
		assets.clear();
		fetches.length = 0;
		assets.set('source.js', SOURCE_JS);
		fetchImpl = (id, url) =>
			Promise.resolve({ url, status: 200, body: JSON.stringify({ t: 21.5, text: 'sunny' }) });
	});
	afterEach(() => {
		stop?.();
		stop = null;
	});

	it('runs requests → fetch → transform → hub with namespaced ids and an ok status', async () => {
		const hub = createTelemetryHub();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		stop = await startPackageSource(manifest(), hub);
		await until(() => textOf(hub, 'pkg.wx.status') === 'ok');
		expect(fetches).toEqual([{ id: 'wx', url: 'https://api.example.com/now' }]);
		expect(hub.sensor('pkg.wx.temp').getSnapshot().value).toEqual({
			kind: 'scalar',
			value: 21.5
		});
		expect(hub.sensor('pkg.wx.summary').getSnapshot().value).toEqual({
			kind: 'text',
			value: 'sunny'
		});
		// The undeclared sensor never reaches the hub — it is dropped with a warning.
		expect(hub.sensorIds()).not.toContain('pkg.wx.undeclared');
		expect(warn.mock.calls.some((c) => String(c[1]).includes('undeclared'))).toBe(true);
		warn.mockRestore();
	});

	it('maps a failed fetch to { status: 0 } so transform decides what a miss means', async () => {
		fetchImpl = () => Promise.reject(new Error('host not in allowlist'));
		const hub = createTelemetryHub();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		stop = await startPackageSource(manifest(), hub);
		await until(() => textOf(hub, 'pkg.wx.status') === 'ok');
		expect(textOf(hub, 'pkg.wx.summary')).toBe('offline');
		warn.mockRestore();
	});

	it('reports a missing or non-exporting source.js as an error status without throwing', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const hub = createTelemetryHub();
		assets.delete('source.js');
		stop = await startPackageSource(manifest(), hub);
		expect(textOf(hub, 'pkg.wx.status')).toContain('error:');
		stop();

		assets.set('source.js', 'module.exports = { requests: 1 };');
		stop = await startPackageSource(manifest(), hub);
		expect(textOf(hub, 'pkg.wx.status')).toContain('error:');
		expect(textOf(hub, 'pkg.wx.status')).toContain('module.exports');
		warn.mockRestore();
	});

	it('reports a runaway transform as an error status (deadline trips, loop survives)', async () => {
		assets.set(
			'source.js',
			`module.exports = {
				requests: function () { return []; },
				transform: function () { while (true) {} }
			};`
		);
		const hub = createTelemetryHub();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		stop = await startPackageSource(manifest(), hub);
		await until(() => (textOf(hub, 'pkg.wx.status') ?? '').startsWith('error: transform()'));
		warn.mockRestore();
	});

	it('stop() halts the loop and disposes the sandbox', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const hub = createTelemetryHub();
		stop = await startPackageSource(manifest(), hub);
		await until(() => textOf(hub, 'pkg.wx.status') === 'ok');
		stop();
		stop = null;
		const seen = fetches.length;
		await new Promise((r) => setTimeout(r, 50));
		expect(fetches.length).toBe(seen); // no further ticks
		warn.mockRestore();
	});
});
