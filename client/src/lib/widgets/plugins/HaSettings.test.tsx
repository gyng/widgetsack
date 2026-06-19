import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

// Mock the Tauri command adapter so the panel (and the ha-source it drives) can be exercised
// without a backend. Each fn is a spy so we can assert call args + ordering (Save must save →
// disconnect → connect). listHaEntities feeds the entity browser via ha-source.refreshHaCatalog.
vi.mock('./ha-commands', () => ({
	haConfigStatus: vi.fn(() =>
		Promise.resolve({ configured: true, url: 'http://ha:8123', insecure: false, base_path: '' })
	),
	saveHaConfig: vi.fn(() => Promise.resolve()),
	haConnect: vi.fn(() => Promise.resolve()),
	haDisconnect: vi.fn(() => Promise.resolve()),
	haTestConnection: vi.fn(() => Promise.resolve({ ha_version: '2026.6.0' })),
	listHaEntities: vi.fn(() =>
		Promise.resolve([
			{ entity_id: 'light.kitchen', state: 'on', friendly_name: 'Kitchen Light' },
			{ entity_id: 'sensor.temp', state: '21.4', friendly_name: 'Temp', unit: '°C' }
		])
	),
	haRegistrySnapshot: vi.fn(() =>
		Promise.resolve({
			areas: [{ area_id: 'living', name: 'Living Room' }],
			devices: [{ id: 'd1', name: 'Lamp', area_id: 'living', manufacturer: null, model: null }],
			entities: [
				{
					entity_id: 'light.kitchen',
					device_id: 'd1',
					area_id: null,
					name: null,
					original_name: 'Kitchen',
					platform: 'hue'
				},
				{
					entity_id: 'sensor.temp',
					device_id: null,
					area_id: null,
					name: null,
					original_name: 'Temp',
					platform: 'x'
				}
			]
		})
	)
}));
vi.mock('../../overlay', () => ({ copyToClipboard: vi.fn(() => Promise.resolve(true)) }));

import HaSettings from './HaSettings';
import {
	haConfigStatus,
	haConnect,
	haDisconnect,
	haRegistrySnapshot,
	haTestConnection,
	listHaEntities,
	saveHaConfig
} from './ha-commands';
import { copyToClipboard } from '../../overlay';
import { haExposedStore } from './ha-exposed-store';
import { createTelemetryHub, type TelemetryHub } from '../../core/telemetry';
import { TelemetryHubContext } from '../telemetryContext';

let hub: TelemetryHub;

function renderPanel() {
	hub = createTelemetryHub();
	return render(
		<TelemetryHubContext.Provider value={hub}>
			<HaSettings />
		</TelemetryHubContext.Provider>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	haExposedStore.set([]); // reset the persisted allowlist between tests
	vi.mocked(haConfigStatus).mockResolvedValue({
		configured: true,
		url: 'http://ha:8123',
		insecure: false,
		base_path: ''
	});
});

describe('HaSettings', () => {
	it('prefills the URL from ha_config_status and never shows a token', async () => {
		const { container } = renderPanel();
		const url = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('http://ha:8123'));
		// The token field is write-only: it stays empty even though HA is configured.
		const token = container.querySelector('input[type="password"]') as HTMLInputElement;
		expect(token.value).toBe('');
		// Ensures the live feed is running in the studio window for the badge.
		expect(haConnect).toHaveBeenCalled();
	});

	it('saves then reconnects in order (save → disconnect → connect)', async () => {
		const { getByText, container } = renderPanel();
		const url = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('http://ha:8123')); // wait for the async prefill
		const token = container.querySelector('input[type="password"]') as HTMLInputElement;
		fireEvent.change(token, { target: { value: 'secret-token' } });
		fireEvent.click(getByText('Save & connect'));

		await waitFor(() =>
			expect(saveHaConfig).toHaveBeenCalledWith('http://ha:8123', 'secret-token', false, '')
		);
		await waitFor(() => expect(haDisconnect).toHaveBeenCalled());
		// Disconnect-first is mandatory: ha_connect is idempotent and would no-op against the old task.
		const save = vi.mocked(saveHaConfig).mock.invocationCallOrder[0];
		const disc = vi.mocked(haDisconnect).mock.invocationCallOrder[0];
		const conn = vi.mocked(haConnect).mock.invocationCallOrder.at(-1) as number;
		expect(save).toBeLessThan(disc);
		expect(disc).toBeLessThan(conn);
		// Token is cleared back to write-only after a successful save.
		await waitFor(() => expect(token.value).toBe(''));
	});

	it('tests the connection and reports the HA version', async () => {
		const { getByText, findByText, container } = renderPanel();
		const url = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('http://ha:8123'));
		fireEvent.click(getByText('Test connection'));
		expect(haTestConnection).toHaveBeenCalled();
		expect(await findByText(/Home Assistant 2026\.6\.0/)).toBeTruthy();
	});

	it('shows the connection error message when the test rejects', async () => {
		vi.mocked(haTestConnection).mockRejectedValueOnce('auth_invalid: bad token');
		const { getByText, findByText, container } = renderPanel();
		const url = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('http://ha:8123'));
		fireEvent.click(getByText('Test connection'));
		expect(await findByText(/auth_invalid: bad token/)).toBeTruthy();
	});

	it('reflects the live ha.status sample in the badge', async () => {
		const { getByText } = renderPanel();
		await waitFor(() => expect(haConfigStatus).toHaveBeenCalled());
		act(() => {
			hub.ingest({ sensor: 'ha.status', ts_ms: 0, value: { kind: 'text', value: 'connected' } });
		});
		expect(getByText(/Connected/)).toBeTruthy();
	});

	it('lists entities (friendly name) and toggling Expose updates the allowlist', async () => {
		const { findByText, getByLabelText } = renderPanel();
		// Entities arrive from ha-source.refreshHaCatalog → listHaEntities (mocked).
		expect(await findByText('Kitchen Light')).toBeTruthy();
		const box = getByLabelText('Expose Kitchen Light') as HTMLInputElement;
		expect(box.checked).toBe(false);
		fireEvent.click(box);
		expect(haExposedStore.getSnapshot()).toEqual(['ha.light.kitchen']);
		// Clicking again un-exposes it.
		fireEvent.click(box);
		expect(haExposedStore.getSnapshot()).toEqual([]);
	});

	it('filters the entity list by the search box', async () => {
		const { findByText, queryByText, getByLabelText } = renderPanel();
		await findByText('Kitchen Light');
		fireEvent.change(getByLabelText('Filter entities'), { target: { value: 'temp' } });
		expect(queryByText('Kitchen Light')).toBeNull();
		expect(queryByText('Temp')).toBeTruthy();
	});

	it('copies the ha.<entity_id> sensor id', async () => {
		const { findByText, getByLabelText } = renderPanel();
		await findByText('Kitchen Light');
		fireEvent.click(getByLabelText('Copy sensor id ha.light.kitchen'));
		expect(copyToClipboard).toHaveBeenCalledWith('ha.light.kitchen');
	});

	it('groups entities by area > device when "Group by area" is enabled', async () => {
		const { findByText, getByLabelText } = renderPanel();
		await findByText('Kitchen Light'); // flat list populated first
		fireEvent.click(getByLabelText('Group by area'));
		// Area + device headers from the (mocked) registry snapshot.
		expect(await findByText('Living Room')).toBeTruthy();
		expect(await findByText('Lamp')).toBeTruthy();
		// The device-less entity lands under the Unassigned bucket.
		expect(await findByText('Unassigned')).toBeTruthy();
	});

	it('edits the URL field (marking the form dirty) and the basePath in Advanced', async () => {
		const { container, findByText } = renderPanel();
		await findByText('Kitchen Light');
		const url = container.querySelector('input[type="text"]') as HTMLInputElement;
		fireEvent.change(url, { target: { value: 'http://ha.local:8123' } });
		expect(url.value).toBe('http://ha.local:8123');
		// The reverse-proxy subpath input is the second text-typed field (inside <details>).
		const texts = container.querySelectorAll('input[type="text"]');
		const basePath = texts[1] as HTMLInputElement;
		fireEvent.change(basePath, { target: { value: '/homeassistant' } });
		expect(basePath.value).toBe('/homeassistant');
	});

	it('toggles the insecure-TLS checkbox and shows the warning', async () => {
		const { container, findByText, queryByText } = renderPanel();
		await findByText('Kitchen Light');
		// The first checkbox is the self-signed/invalid TLS toggle.
		const insecure = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(queryByText(/Skips certificate/)).toBeNull();
		fireEvent.click(insecure);
		expect(insecure.checked).toBe(true);
		expect(await findByText(/Skips certificate/)).toBeTruthy();
		// Toggling it back hides the warning again.
		fireEvent.click(insecure);
		expect(queryByText(/Skips certificate/)).toBeNull();
	});

	it('passes the insecure flag and base path through to save', async () => {
		const { container, getByText, findByText } = renderPanel();
		await findByText('Kitchen Light');
		const url = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('http://ha:8123'));
		const insecure = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
		fireEvent.click(insecure);
		const basePath = container.querySelectorAll('input[type="text"]')[1] as HTMLInputElement;
		fireEvent.change(basePath, { target: { value: '/ha' } });
		fireEvent.click(getByText('Save & connect'));
		await waitFor(() =>
			expect(saveHaConfig).toHaveBeenCalledWith('http://ha:8123', '', true, '/ha')
		);
	});

	it('shows a Save failed message when saveHaConfig rejects', async () => {
		vi.mocked(saveHaConfig).mockRejectedValueOnce('disk full');
		const { container, getByText, findByText } = renderPanel();
		const url = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('http://ha:8123'));
		fireEvent.click(getByText('Save & connect'));
		expect(await findByText(/Save failed: disk full/)).toBeTruthy();
	});

	it('reports a bare "Connected" when the test returns no version', async () => {
		vi.mocked(haTestConnection).mockResolvedValueOnce({ ha_version: '' });
		const { container, getByText, findByText } = renderPanel();
		const url = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('http://ha:8123'));
		fireEvent.click(getByText('Test connection'));
		const ok = await findByText('Connected');
		expect(ok.textContent).toBe('Connected');
	});

	it('refreshes the entity catalog from the Refresh button', async () => {
		const { findByText, getByText } = renderPanel();
		await findByText('Kitchen Light');
		vi.mocked(listHaEntities).mockResolvedValueOnce([
			{ entity_id: 'switch.fan', state: 'off', friendly_name: 'Fan' }
		]);
		fireEvent.click(getByText('↻ Refresh'));
		expect(await findByText('Fan')).toBeTruthy();
	});

	it('shows "No entities match the filter." when the flat search excludes everything', async () => {
		const { findByText, getByLabelText } = renderPanel();
		await findByText('Kitchen Light');
		fireEvent.change(getByLabelText('Filter entities'), { target: { value: 'zzz-nope' } });
		expect(await findByText('No entities match the filter.')).toBeTruthy();
	});

	it('bulk-exposes then clears every visible entity', async () => {
		const { findByText, getByText } = renderPanel();
		await findByText('Kitchen Light');
		fireEvent.click(getByText('Expose all'));
		expect(haExposedStore.getSnapshot()).toEqual(['ha.light.kitchen', 'ha.sensor.temp']);
		fireEvent.click(getByText('Clear'));
		expect(haExposedStore.getSnapshot()).toEqual([]);
	});

	it('filters the grouped tree (exercising the tree match fn)', async () => {
		const { findAllByText, findByText, queryByText, getByLabelText } = renderPanel();
		await findByText('Kitchen Light');
		fireEvent.click(getByLabelText('Group by area'));
		await findByText('Living Room');
		// Filter the grouped tree down to the kitchen light (exercises the tree match fn,
		// which drops the device-less Temp entity from the Unassigned bucket).
		fireEvent.change(getByLabelText('Filter entities'), { target: { value: 'kitchen' } });
		await waitFor(() => expect(queryByText('Temp')).toBeNull());
		// The grouped name uses live.friendly_name precedence → 'Kitchen Light'.
		expect((await findAllByText('Kitchen Light')).length).toBeGreaterThan(0);
	});

	it('shows "Loading registry…" when grouping is on before the registry resolves', async () => {
		// Never-resolving snapshot → the grouped view stays in its loading state with no tree.
		vi.mocked(haRegistrySnapshot).mockReturnValueOnce(new Promise(() => undefined));
		const { findByText, getByLabelText } = renderPanel();
		await findByText('Kitchen Light');
		fireEvent.click(getByLabelText('Group by area'));
		// The flat entities are gone (grouped view) but the registry hasn't arrived yet.
		expect(await findByText('Loading registry…')).toBeTruthy();
	});

	it('falls back to the entity_id when an entity has no friendly name', async () => {
		vi.mocked(listHaEntities).mockResolvedValueOnce([{ entity_id: 'light.bare', state: 'on' }]);
		const { findAllByText } = renderPanel();
		// No friendly_name → the name cell shows the entity_id itself (also shown in the id <code>).
		expect((await findAllByText('light.bare')).length).toBeGreaterThan(0);
	});

	it('filters past a friendly-name-less entity (the `?? ""` fallback in the predicate)', async () => {
		// switch.bare has no friendly_name; a query that misses its entity_id forces the predicate to
		// evaluate `(e.friendly_name ?? '')` on a null name (the left `||` arm being false).
		vi.mocked(listHaEntities).mockResolvedValueOnce([
			{ entity_id: 'light.kitchen', state: 'on', friendly_name: 'Kitchen Light' },
			{ entity_id: 'switch.bare', state: 'off' }
		]);
		const { findByText, getByLabelText, queryByText } = renderPanel();
		await findByText('Kitchen Light');
		fireEvent.change(getByLabelText('Filter entities'), { target: { value: 'kitchen' } });
		// switch.bare is dropped (its id misses + it has no friendly_name); kitchen stays.
		await waitFor(() => expect(queryByText('switch.bare')).toBeNull());
		expect(await findByText('Kitchen Light')).toBeTruthy();
	});

	it('shows "No entities match the filter." in the grouped view too', async () => {
		const { findByText, getByLabelText } = renderPanel();
		await findByText('Kitchen Light');
		fireEvent.click(getByLabelText('Group by area'));
		await findByText('Living Room'); // registry resolved
		fireEvent.change(getByLabelText('Filter entities'), { target: { value: 'zzz-nope' } });
		expect(await findByText('No entities match the filter.')).toBeTruthy();
	});

	it('renders a registry entity with no live state in the grouped tree', async () => {
		// The registry can list an entity that /api/states didn't return → no liveMap entry, so its
		// state falls back to '' (exercises `e.state ?? ''` for both device + loose grouped rows).
		vi.mocked(haRegistrySnapshot).mockResolvedValueOnce({
			areas: [{ area_id: 'living', name: 'Living Room' }],
			devices: [{ id: 'd1', name: 'Lamp', area_id: 'living', manufacturer: null, model: null }],
			entities: [
				{
					entity_id: 'light.ghost', // not in listHaEntities → no live state
					device_id: 'd1',
					area_id: null,
					name: 'Ghost Light',
					original_name: null,
					platform: 'x'
				},
				{
					entity_id: 'sensor.loose', // device-less + no live state → loose row
					device_id: null,
					area_id: null,
					name: 'Loose Sensor',
					original_name: null,
					platform: 'x'
				}
			]
		});
		const { findByText, getByLabelText } = renderPanel();
		await findByText('Kitchen Light');
		fireEvent.click(getByLabelText('Group by area'));
		expect(await findByText('Ghost Light')).toBeTruthy();
		expect(await findByText('Loose Sensor')).toBeTruthy();
	});

	it('defaults the URL to empty when ha_config_status omits it', async () => {
		// Exercises the `s.url ?? ''` fallback in the prefill effect.
		vi.mocked(haConfigStatus).mockResolvedValueOnce({
			configured: false,
			url: null,
			insecure: false,
			base_path: ''
		});
		const { container, findByText } = renderPanel();
		await findByText('Kitchen Light');
		const url = container.querySelector('input[type="text"]') as HTMLInputElement;
		expect(url.value).toBe('');
	});
});
