// The Home Assistant plugin (Phase 8c) — the first build-time plugin, and the worked
// example of the Phase 8 plugin API. Calling `registerHomeAssistantPlugin()` registers its
// source + widgets via `registerPlugin`; plugins/index.ts calls it (error-isolated) for
// Canvas. Adding HA touches no core wiring: the widgets go through the same
// registerMeta/createWidget path as the built-ins, and the data rides the existing
// `telemetry` event (see ha-source.ts).

import { registerPlugin } from '../plugin';
import { haSource } from './ha-source';
import { haCallService } from './ha-commands';
import HaSettings from './HaSettings';
import HaSensor from '../meters/HaSensor';
import HaLight from '../meters/HaLight';
import HaClimate from '../meters/HaClimate';
import HaSwitch from '../meters/HaSwitch';
import HaScene from '../meters/HaScene';
import HaFan from '../meters/HaFan';
import HaCover from '../meters/HaCover';
import HaLock from '../meters/HaLock';
import HaBinarySensor from '../meters/HaBinarySensor';
import HaInput from '../meters/HaInput';
import { asMeter } from '../registry';

// HA widgets have no defaultSensor — the entity is unknown until the user picks one from
// the inspector's sensor dropdown (which lists `ha.<entity_id>` ids once connected). They
// bind 'json' so the meter receives the whole HA state object (state + attributes).
export const registerHomeAssistantPlugin = (): void =>
	registerPlugin({
		id: 'home-assistant',
		name: 'Home Assistant',
		description:
			'Sensors, lights and climate from Home Assistant. Configured server-side via plugins/ha.json.',
		sources: [haSource],
		settings: HaSettings,
		statusSensor: 'ha.status',
		// The catch-all control handler: any non-media {domain, service} bang is an HA service call
		// (light.turn_on, climate.set_temperature, …), targeting the action's explicit `data.entity_id`
		// (macros on an unbound button supply it) or, falling back, the firing widget's bound
		// `ha.<entity>` sensor. Resolves to a no-op when there's no entity to target; rejects on
		// invoke failure so a macro run can record the failed step.
		actions: [
			{
				domain: '*',
				dispatch: async ({ domain, service, data }, { sensor }) => {
					const entity_id =
						(data?.entity_id as string | undefined) ??
						(sensor && sensor.startsWith('ha.') ? sensor.slice('ha.'.length) : undefined);
					if (!entity_id) return;
					// Merge the action's control data (e.g. brightness, temperature) with the resolved entity.
					await haCallService(domain, service, { entity_id, ...data });
				}
			}
		],
		// All grouped under a "Home Assistant" palette category. Read-only meters (sensor /
		// binary_sensor) omit `interactive`; the control widgets set it so clicks aren't passed through
		// the overlay. Every control just emits onControl — the `'*'` action above performs the
		// ha_call_service, resolving the entity from the bound `ha.<entity>` sensor. The control
		// widgets expose `show*` toggles so each sub-control (mode / fan / brightness / position …) can
		// be turned off per widget.
		widgets: [
			{
				meta: {
					type: 'ha.sensor',
					binds: 'json',
					label: 'HA Sensor',
					category: 'Home Assistant',
					defaultSize: { w: 150, h: 44 },
					defaultConfig: {},
					configFields: [{ key: 'label', label: 'label', kind: 'text' }]
				},
				component: asMeter(HaSensor)
			},
			{
				meta: {
					type: 'ha.binary_sensor',
					binds: 'json',
					label: 'HA Binary Sensor',
					category: 'Home Assistant',
					defaultSize: { w: 150, h: 44 },
					defaultConfig: {},
					configFields: [{ key: 'label', label: 'label', kind: 'text' }]
				},
				component: asMeter(HaBinarySensor)
			},
			{
				meta: {
					type: 'ha.light',
					binds: 'json',
					label: 'HA Light',
					category: 'Home Assistant',
					interactive: true,
					defaultSize: { w: 120, h: 48 },
					defaultConfig: { showBrightness: true },
					configFields: [
						{ key: 'label', label: 'label', kind: 'text' },
						{ key: 'showBrightness', label: 'brightness slider', kind: 'toggle' }
					]
				},
				component: asMeter(HaLight)
			},
			{
				meta: {
					type: 'ha.switch',
					binds: 'json',
					label: 'HA Switch',
					category: 'Home Assistant',
					interactive: true,
					defaultSize: { w: 120, h: 48 },
					defaultConfig: {},
					configFields: [{ key: 'label', label: 'label', kind: 'text' }]
				},
				component: asMeter(HaSwitch)
			},
			{
				meta: {
					type: 'ha.fan',
					binds: 'json',
					label: 'HA Fan',
					category: 'Home Assistant',
					interactive: true,
					defaultSize: { w: 150, h: 56 },
					defaultConfig: { showSpeed: true, showOscillate: true },
					configFields: [
						{ key: 'label', label: 'label', kind: 'text' },
						{ key: 'showSpeed', label: 'speed slider', kind: 'toggle' },
						{ key: 'showOscillate', label: 'oscillate toggle', kind: 'toggle' }
					]
				},
				component: asMeter(HaFan)
			},
			{
				meta: {
					type: 'ha.climate',
					binds: 'json',
					label: 'HA Climate / A-C',
					category: 'Home Assistant',
					interactive: true,
					defaultSize: { w: 170, h: 92 },
					defaultConfig: { showMode: true, showTemp: true, showFan: true },
					configFields: [
						{ key: 'label', label: 'label', kind: 'text' },
						{ key: 'showMode', label: 'mode toggle', kind: 'toggle' },
						{ key: 'showTemp', label: 'temp buttons', kind: 'toggle' },
						{ key: 'showFan', label: 'fan-mode select', kind: 'toggle' }
					]
				},
				component: asMeter(HaClimate)
			},
			{
				meta: {
					type: 'ha.cover',
					binds: 'json',
					label: 'HA Cover',
					category: 'Home Assistant',
					interactive: true,
					defaultSize: { w: 150, h: 76 },
					defaultConfig: { showButtons: true, showPosition: true },
					configFields: [
						{ key: 'label', label: 'label', kind: 'text' },
						{ key: 'showButtons', label: 'open / close buttons', kind: 'toggle' },
						{ key: 'showPosition', label: 'position slider', kind: 'toggle' }
					]
				},
				component: asMeter(HaCover)
			},
			{
				meta: {
					type: 'ha.lock',
					binds: 'json',
					label: 'HA Lock',
					category: 'Home Assistant',
					interactive: true,
					defaultSize: { w: 120, h: 48 },
					defaultConfig: {},
					configFields: [{ key: 'label', label: 'label', kind: 'text' }]
				},
				component: asMeter(HaLock)
			},
			{
				meta: {
					type: 'ha.scene',
					binds: 'json',
					label: 'HA Scene',
					category: 'Home Assistant',
					interactive: true,
					defaultSize: { w: 130, h: 40 },
					defaultConfig: {},
					configFields: [{ key: 'label', label: 'label', kind: 'text' }]
				},
				component: asMeter(HaScene)
			},
			{
				meta: {
					type: 'ha.input',
					binds: 'json',
					label: 'HA Input',
					category: 'Home Assistant',
					interactive: true,
					defaultSize: { w: 160, h: 48 },
					defaultConfig: {},
					configFields: [{ key: 'label', label: 'label', kind: 'text' }]
				},
				component: asMeter(HaInput)
			}
		]
	});
