import { describe, expect, it, vi } from 'vitest';
import { registerHomeAssistantPlugin } from './home-assistant';
import { getMeta } from '../../core/widget';
import { listSources } from '../../core/plugin';
import { actionHandlerFor } from '../plugin';
import { haCallService } from './ha-commands';

// Keep the real adapter shape (ha-source etc. import from here) but stub the one call we assert.
vi.mock('./ha-commands', async (importOriginal) => ({
	...(await importOriginal<typeof import('./ha-commands')>()),
	haCallService: vi.fn()
}));

registerHomeAssistantPlugin();

describe('home-assistant plugin', () => {
	const types = [
		'ha.sensor',
		'ha.binary_sensor',
		'ha.light',
		'ha.switch',
		'ha.fan',
		'ha.climate',
		'ha.cover',
		'ha.lock',
		'ha.scene',
		'ha.input',
		'ha.media_player'
	];

	it('registers every HA widget as json-bound under the "Home Assistant" category', () => {
		for (const t of types) {
			const meta = getMeta(t);
			expect(meta, t).toBeTruthy();
			expect(meta?.binds).toBe('json');
			expect(meta?.category).toBe('Home Assistant');
		}
	});

	it('marks control widgets interactive, leaves read-only sensors passive', () => {
		expect(getMeta('ha.light')?.interactive).toBe(true);
		expect(getMeta('ha.media_player')?.interactive).toBe(true);
		expect(getMeta('ha.cover')?.interactive).toBe(true);
		expect(getMeta('ha.sensor')?.interactive).toBeFalsy();
		expect(getMeta('ha.binary_sensor')?.interactive).toBeFalsy();
	});

	it('exposes show* config toggles on controls with sub-controls', () => {
		const keys = (t: string): string[] => (getMeta(t)?.configFields ?? []).map((f) => f.key);
		expect(keys('ha.climate')).toEqual(expect.arrayContaining(['showMode', 'showTemp', 'showFan']));
		expect(keys('ha.fan')).toEqual(expect.arrayContaining(['showSpeed', 'showOscillate']));
		expect(keys('ha.cover')).toEqual(expect.arrayContaining(['showButtons', 'showPosition']));
		expect(keys('ha.light')).toEqual(expect.arrayContaining(['showBrightness']));
		expect(keys('ha.media_player')).toEqual(
			expect.arrayContaining(['showTransport', 'showVolume'])
		);
	});

	it('registers its source + a catch-all control action', () => {
		expect(listSources().some((s) => s.id === 'home-assistant')).toBe(true);
		// Any non-media domain (light/switch/climate/…) routes through the '*' catch-all → ha_call_service.
		expect(actionHandlerFor('light')).toBeTruthy();
		expect(actionHandlerFor('climate')).toBeTruthy();
	});

	it('the catch-all action resolves the entity + calls ha_call_service', async () => {
		const dispatch = actionHandlerFor('light');
		if (!dispatch) throw new Error('no catch-all handler');
		vi.mocked(haCallService).mockClear();

		// Bound `ha.<entity>` sensor supplies the entity when data carries none.
		await dispatch({ domain: 'light', service: 'toggle' }, { sensor: 'ha.light.kitchen' });
		expect(haCallService).toHaveBeenCalledWith('light', 'toggle', { entity_id: 'light.kitchen' });

		// Explicit data.entity_id wins; extra data (brightness) is merged.
		await dispatch(
			{ domain: 'light', service: 'turn_on', data: { entity_id: 'light.x', brightness_pct: 50 } },
			{ sensor: undefined }
		);
		expect(haCallService).toHaveBeenLastCalledWith('light', 'turn_on', {
			entity_id: 'light.x',
			brightness_pct: 50
		});

		// No entity from data or sensor → no service call.
		vi.mocked(haCallService).mockClear();
		await dispatch({ domain: 'light', service: 'toggle' }, { sensor: undefined });
		expect(haCallService).not.toHaveBeenCalled();
	});
});
