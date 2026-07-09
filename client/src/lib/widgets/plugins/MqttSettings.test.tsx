import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

// Mock the MQTT command adapter (the source it drives uses these too). Password is write-only.
vi.mock('./mqtt-commands', () => ({
	mqttConfigStatus: vi.fn(() =>
		Promise.resolve({
			configured: true,
			host: 'broker.local',
			port: 1883,
			username: 'u',
			topics: ['zigbee2mqtt/#', 'tasmota/SENSOR'],
			tls: false,
			insecure: false,
			discovery: true
		})
	),
	saveMqttConfig: vi.fn(() => Promise.resolve()),
	mqttConnect: vi.fn(() => Promise.resolve()),
	mqttDisconnect: vi.fn(() => Promise.resolve()),
	mqttCatalog: vi.fn(() =>
		Promise.resolve([
			{ id: 'mqtt.zigbee2mqtt/temp', topic: 'zigbee2mqtt/temp', label: 'Temp', unit: '°C' }
		])
	)
}));
vi.mock('../../overlay', () => ({ copyToClipboard: vi.fn(() => Promise.resolve(true)) }));

import MqttSettings from './MqttSettings';
import {
	mqttCatalog,
	mqttConfigStatus,
	mqttConnect,
	mqttDisconnect,
	saveMqttConfig
} from './mqtt-commands';
import { copyToClipboard } from '../../overlay';
import { createTelemetryHub, type TelemetryHub } from '../../core/telemetry';
import { TelemetryHubContext } from '../telemetryContext';

let hub: TelemetryHub;

function renderPanel() {
	hub = createTelemetryHub();
	return render(
		<TelemetryHubContext.Provider value={hub}>
			<MqttSettings />
		</TelemetryHubContext.Provider>
	);
}

beforeEach(() => vi.clearAllMocks());

describe('MqttSettings', () => {
	it('prefills the broker form and never shows a password', async () => {
		const { container } = renderPanel();
		const host = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(host.value).toBe('broker.local'));
		const pw = container.querySelector('input[type="password"]') as HTMLInputElement;
		expect(pw.value).toBe('');
	});

	it('saves the parsed topic list then reconnects', async () => {
		const { getByText, container } = renderPanel();
		const host = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(host.value).toBe('broker.local'));
		fireEvent.click(getByText('Save & connect'));
		await waitFor(() =>
			expect(saveMqttConfig).toHaveBeenCalledWith(
				expect.objectContaining({
					host: 'broker.local',
					topics: ['zigbee2mqtt/#', 'tasmota/SENSOR'],
					discovery: true
				})
			)
		);
		await waitFor(() => expect(mqttDisconnect).toHaveBeenCalled());
	});

	it('lists catalog topics and copies the mqtt.<topic> id', async () => {
		const { findByText, getByLabelText } = renderPanel();
		await findByText('Temp');
		fireEvent.click(getByLabelText('Copy sensor id mqtt.zigbee2mqtt/temp'));
		expect(copyToClipboard).toHaveBeenCalledWith('mqtt.zigbee2mqtt/temp');
	});

	it('reflects the live mqtt.status sample in the badge', async () => {
		const { getByText } = renderPanel();
		await waitFor(() => expect(mqttConfigStatus).toHaveBeenCalled());
		act(() => {
			hub.ingest({ sensor: 'mqtt.status', ts_ms: 0, value: { kind: 'text', value: 'connected' } });
		});
		expect(getByText(/Connected/)).toBeTruthy();
	});

	it('edits every broker field, toggles the options and folds them into the save body', async () => {
		const { container, getByText, getByLabelText, getByPlaceholderText } = renderPanel();
		const host = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(host.value).toBe('broker.local'));

		fireEvent.change(host, { target: { value: 'mqtt.example' } });
		const port = container.querySelector('input[type="number"]') as HTMLInputElement;
		fireEvent.change(port, { target: { value: '8883' } });
		const username = getByPlaceholderText('(optional)') as HTMLInputElement;
		fireEvent.change(username, { target: { value: 'alice' } });
		const password = container.querySelector('input[type="password"]') as HTMLInputElement;
		fireEvent.change(password, { target: { value: 'secret' } });
		const clientId = getByPlaceholderText('widgetsack (default)') as HTMLInputElement;
		fireEvent.change(clientId, { target: { value: 'cid' } });

		// Removing a topic chip drives the TokenListField onChange.
		fireEvent.click(getByLabelText('Remove tasmota/SENSOR'));

		// Discovery defaults ON (status.discovery=true) → toggle it OFF; flip TLS + insecure ON.
		const discovery = [...container.querySelectorAll('input[type="checkbox"]')].find((c) =>
			c.closest('label')?.textContent?.includes('discovery')
		) as HTMLInputElement;
		const tls = [...container.querySelectorAll('input[type="checkbox"]')].find((c) =>
			c.closest('label')?.textContent?.includes('Use TLS')
		) as HTMLInputElement;
		const insecure = [...container.querySelectorAll('input[type="checkbox"]')].find((c) =>
			c.closest('label')?.textContent?.includes('self-signed')
		) as HTMLInputElement;
		fireEvent.click(discovery);
		fireEvent.click(tls);
		fireEvent.click(insecure);
		// The self-signed warning renders once insecure is checked.
		expect(getByText(/only for a trusted LAN broker/)).toBeTruthy();

		fireEvent.click(getByText('Save & connect'));
		await waitFor(() =>
			expect(saveMqttConfig).toHaveBeenCalledWith(
				expect.objectContaining({
					host: 'mqtt.example',
					port: 8883,
					username: 'alice',
					password: 'secret',
					clientId: 'cid',
					topics: ['zigbee2mqtt/#'],
					tls: true,
					insecure: true,
					discovery: false
				})
			)
		);
	});

	it('falls back to port 1883 when the port field is cleared', async () => {
		const { container, getByText } = renderPanel();
		const host = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(host.value).toBe('broker.local'));
		const port = container.querySelector('input[type="number"]') as HTMLInputElement;
		fireEvent.change(port, { target: { value: '' } });
		fireEvent.click(getByText('Save & connect'));
		await waitFor(() =>
			expect(saveMqttConfig).toHaveBeenCalledWith(expect.objectContaining({ port: 1883 }))
		);
	});

	it('surfaces a save failure (Error message) in the error line', async () => {
		vi.mocked(saveMqttConfig).mockRejectedValueOnce(new Error('broker refused'));
		const { container, getByText, findByText } = renderPanel();
		const host = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(host.value).toBe('broker.local'));
		fireEvent.click(getByText('Save & connect'));
		expect(await findByText(/Couldn’t save: broker refused/)).toBeTruthy();
	});

	it('surfaces a non-Error save failure stringified', async () => {
		vi.mocked(saveMqttConfig).mockRejectedValueOnce('disk full');
		const { container, getByText, findByText } = renderPanel();
		const host = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(host.value).toBe('broker.local'));
		fireEvent.click(getByText('Save & connect'));
		expect(await findByText(/Couldn’t save: disk full/)).toBeTruthy();
	});

	it('refreshes the topic catalog on demand and falls back to the topic when an entry has no label', async () => {
		// First mount loads the default catalog; the refresh returns a label-less entry → topic fallback.
		const { findByText, getByText } = renderPanel();
		await findByText('Temp');
		vi.mocked(mqttCatalog).mockResolvedValueOnce([
			{ id: 'mqtt.tasmota/x', topic: 'tasmota/x', label: null, unit: null }
		]);
		fireEvent.click(getByText('↻ Refresh'));
		// The label-less entry renders its topic as the name (e.label ?? e.topic).
		const name = await findByText('tasmota/x', { selector: '.has-entity-name' });
		expect(name).toBeTruthy();
	});

	it('auto-dismisses the "Saved ✓" tick after 2.5s', async () => {
		vi.useFakeTimers();
		try {
			const { container, getByText, queryByText } = renderPanel();
			await act(async () => {}); // flush the prefill promises (host must be set for canSubmit)
			const host = container.querySelector('input[type="text"]') as HTMLInputElement;
			expect(host.value).toBe('broker.local');
			fireEvent.click(getByText('Save & connect'));
			await act(async () => {}); // flush the save → disconnect → connect → catalog chain
			expect(getByText('Saved ✓')).toBeTruthy();
			act(() => {
				vi.advanceTimersByTime(2500);
			});
			expect(queryByText('Saved ✓')).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('renders with defaults when the connect kick and the status fetch both reject', async () => {
		vi.mocked(mqttConnect).mockRejectedValue(new Error('no backend'));
		vi.mocked(mqttConfigStatus).mockRejectedValue(new Error('no backend'));
		const { container, findByText } = renderPanel();
		// Both rejections are swallowed; the panel stays usable with its default (empty) form.
		expect(await findByText('not configured')).toBeTruthy();
		const host = container.querySelector('input[type="text"]') as HTMLInputElement;
		expect(host.value).toBe('');
	});

	it('ignores a status result that resolves after unmount (no setState on a dead panel)', async () => {
		type Status = Awaited<ReturnType<typeof mqttConfigStatus>>;
		let resolveStatus: (s: Status) => void = () => undefined;
		vi.mocked(mqttConfigStatus).mockImplementation(
			() => new Promise((res) => (resolveStatus = res))
		);
		const { container, unmount } = renderPanel();
		const host = container.querySelector('input[type="text"]') as HTMLInputElement;
		expect(host.value).toBe('');
		unmount();
		// Resolving late must hit the `alive` guard, not a state setter on the unmounted panel.
		await act(async () => {
			resolveStatus({
				configured: true,
				host: 'late.local',
				port: 1883,
				username: '',
				topics: [],
				tls: false,
				insecure: false,
				discovery: false
			});
		});
	});
});
