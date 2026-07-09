import { describe, expect, it } from 'vitest';
import {
	actionHandlerFor,
	listPlugins,
	pluginSensorNames,
	pluginSensorNamesFrom,
	registerPlugin,
	statusDotFrom,
	type Plugin
} from './plugin';
import { getMeta } from '../core/widget';
import { getControl } from '../core/controls';
// A trivial meter component for the widget-registration assertion (a 0-prop component is a valid
// MeterComponent — no cast needed).
const Stub = () => null;
const Settings = () => null;

describe('plugin registry', () => {
	it('records a registered plugin (listPlugins) and wires its widget meta', () => {
		registerPlugin({
			id: 'test.plugin',
			name: 'Test Plugin',
			description: 'a test',
			widgets: [
				{
					meta: {
						type: 'test.widget',
						binds: 'none',
						label: 'Test',
						defaultSize: { w: 10, h: 10 }
					},
					component: Stub
				}
			]
		});
		const found = listPlugins().find((p) => p.id === 'test.plugin');
		expect(found).toMatchObject({ id: 'test.plugin', name: 'Test Plugin', description: 'a test' });
		// The widget half went through registerWidget → the meta is now resolvable.
		expect(getMeta('test.widget')).toMatchObject({ type: 'test.widget', label: 'Test' });
	});

	it('registers plugin-contributed controls into the controls registry', () => {
		registerPlugin({
			id: 'test.controls',
			name: 'With Controls',
			controls: [
				{
					id: 'plugin:test.controls.demo',
					scope: 'widget',
					group: 'widget',
					label: 'Demo action',
					triggers: [{ type: 'key', key: 'd', ctrl: true, shift: true }]
				}
			]
		});
		expect(getControl('plugin:test.controls.demo')).toMatchObject({ label: 'Demo action' });
	});

	it('keeps the optional settings component', () => {
		registerPlugin({ id: 'test.settings', name: 'With Settings', settings: Settings });
		const found = listPlugins().find((p) => p.id === 'test.settings');
		expect(found?.settings).toBe(Settings);
	});

	it('re-registering by id replaces rather than duplicates', () => {
		registerPlugin({ id: 'test.dup', name: 'First' });
		registerPlugin({ id: 'test.dup', name: 'Second' });
		const matches = listPlugins().filter((p) => p.id === 'test.dup');
		expect(matches).toHaveLength(1);
		expect(matches[0].name).toBe('Second');
	});
});

describe('action-handler registry', () => {
	it('resolves an exact domain match and dispatches with the action + context', async () => {
		const calls: unknown[] = [];
		registerPlugin({
			id: 'test.actions',
			name: 'With Actions',
			actions: [{ domain: 'test-media', dispatch: (action, ctx) => void calls.push([action, ctx]) }]
		});
		const handler = actionHandlerFor('test-media');
		expect(handler).toBeTruthy();
		// No handler + no catch-all (registered in the next test) → null, so Canvas can warn.
		expect(actionHandlerFor('unclaimed')).toBeNull();
		await handler?.({ domain: 'test-media', service: 'play' }, { sensor: 'np.title' });
		expect(calls).toEqual([[{ domain: 'test-media', service: 'play' }, { sensor: 'np.title' }]]);
	});

	it('falls back to the "*" catch-all for an unclaimed domain; an exact match wins', async () => {
		const seen: string[] = [];
		registerPlugin({
			id: 'test.catchall',
			name: 'Catch All',
			actions: [
				{ domain: '*', dispatch: (action) => void seen.push(`*:${action.domain}`) },
				{ domain: 'test-exact', dispatch: (action) => void seen.push(`exact:${action.domain}`) }
			]
		});
		await actionHandlerFor('light')?.({ domain: 'light', service: 'turn_on' }, {});
		await actionHandlerFor('climate')?.({ domain: 'climate', service: 'set_temperature' }, {});
		await actionHandlerFor('test-exact')?.({ domain: 'test-exact', service: 's' }, {});
		expect(seen).toEqual(['*:light', '*:climate', 'exact:test-exact']);
	});

	it('re-registering a domain replaces its handler (idempotent remounts)', async () => {
		const seen: string[] = [];
		const withHandler = (tag: string): Plugin => ({
			id: 'test.actions.dup',
			name: 'Dup',
			actions: [{ domain: 'test-dup', dispatch: () => void seen.push(tag) }]
		});
		registerPlugin(withHandler('first'));
		registerPlugin(withHandler('second'));
		await actionHandlerFor('test-dup')?.({ domain: 'test-dup', service: 's' }, {});
		expect(seen).toEqual(['second']);
	});
});

describe('statusDotFrom', () => {
	it('maps live-connection statuses (the ha.rs vocabulary)', () => {
		expect(statusDotFrom('connected')).toEqual({ state: 'ok', label: 'Connected' });
		expect(statusDotFrom('connecting')).toEqual({ state: 'warn', label: 'Connecting…' });
		expect(statusDotFrom('error')).toEqual({ state: 'warn', label: 'Error' });
		expect(statusDotFrom('disconnected')).toEqual({ state: 'off', label: 'Disconnected' });
	});

	it('maps command-derived readiness (configured/unconfigured)', () => {
		expect(statusDotFrom('configured')).toEqual({ state: 'ok', label: 'Configured' });
		expect(statusDotFrom('unconfigured')).toEqual({ state: 'off', label: 'Not configured' });
	});

	it('treats unknown / absent statuses as off', () => {
		expect(statusDotFrom(null)).toEqual({ state: 'off', label: 'Not connected' });
		expect(statusDotFrom(undefined).state).toBe('off');
		expect(statusDotFrom('weird').state).toBe('off');
	});
});

describe('pluginSensorNamesFrom', () => {
	const src = (id: string, catalog: string[]) => ({
		id,
		start: async () => () => undefined,
		catalog: () => catalog
	});
	const list: Plugin[] = [
		{
			id: 'home-assistant',
			name: 'Home Assistant',
			sources: [src('home-assistant', ['ha.light.kitchen', 'ha.sensor.temp'])]
		},
		{ id: 'mqtt', name: 'MQTT', sources: [src('mqtt', ['mqtt.zigbee/temp'])] },
		{ id: 'no-source', name: 'No Source' } // a plugin without a sensor source contributes nothing
	];

	it('maps each plugin-source catalog id to its plugin name', () => {
		const names = pluginSensorNamesFrom(list);
		expect(names.get('ha.light.kitchen')).toBe('Home Assistant');
		expect(names.get('ha.sensor.temp')).toBe('Home Assistant');
		expect(names.get('mqtt.zigbee/temp')).toBe('MQTT');
	});

	it('does not badge built-in / unlisted sensors', () => {
		const names = pluginSensorNamesFrom(list);
		expect(names.has('cpu.total')).toBe(false);
		expect(names.has('mem.used')).toBe(false);
	});

	it('keeps the FIRST plugin’s name when two plugins claim the same sensor id', () => {
		const names = pluginSensorNamesFrom([
			{ id: 'one', name: 'First', sources: [src('one', ['dup.sensor'])] },
			{ id: 'two', name: 'Second', sources: [src('two', ['dup.sensor'])] }
		]);
		expect(names.get('dup.sensor')).toBe('First');
	});

	it('tolerates a source with no catalog() (no ids contributed)', () => {
		const names = pluginSensorNamesFrom([
			{
				id: 'catless',
				name: 'Catless',
				sources: [{ id: 'catless', start: async () => () => undefined }]
			}
		]);
		expect(names.size).toBe(0);
	});
});

describe('pluginSensorNames (live registry)', () => {
	it('reads the live plugin registry', () => {
		registerPlugin({
			id: 'test.livesensor',
			name: 'Live Sensor Plugin',
			sources: [
				{
					id: 'test.livesensor',
					start: async () => () => undefined,
					catalog: () => ['live.sensor.one']
				}
			]
		});
		expect(pluginSensorNames().get('live.sensor.one')).toBe('Live Sensor Plugin');
	});
});
