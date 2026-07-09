import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

// Mock the weather Tauri command adapter so the panel runs without a backend. Each fn is a spy so we
// can assert call args + ordering (Save must save → disconnect → connect). Open-Meteo is keyless, so
// there's no secret field — the form is just location + units + refresh.
vi.mock('./weather-commands', () => ({
	weatherConfigStatus: vi.fn(() =>
		Promise.resolve({
			configured: true,
			latitude: 51.5072,
			longitude: -0.1276,
			unit: 'fahrenheit',
			pollSeconds: 1800
		})
	),
	saveWeatherConfig: vi.fn(() => Promise.resolve()),
	weatherConnect: vi.fn(() => Promise.resolve()),
	weatherDisconnect: vi.fn(() => Promise.resolve())
}));

import WeatherSettings from './WeatherSettings';
import {
	saveWeatherConfig,
	weatherConfigStatus,
	weatherConnect,
	weatherDisconnect
} from './weather-commands';
import { createTelemetryHub, type TelemetryHub } from '../../core/telemetry';
import { TelemetryHubContext } from '../telemetryContext';

let hub: TelemetryHub;

function renderPanel() {
	hub = createTelemetryHub();
	return render(
		<TelemetryHubContext.Provider value={hub}>
			<WeatherSettings />
		</TelemetryHubContext.Provider>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(weatherConfigStatus).mockResolvedValue({
		configured: true,
		latitude: 51.5072,
		longitude: -0.1276,
		unit: 'fahrenheit',
		pollSeconds: 1800
	});
});

describe('WeatherSettings', () => {
	it('prefills the form from weather_config_status and starts the live feed', async () => {
		const { container, getByText } = renderPanel();
		const lat = container.querySelector('input[placeholder="51.5072"]') as HTMLInputElement;
		const lon = container.querySelector('input[placeholder="-0.1276"]') as HTMLInputElement;
		await waitFor(() => expect(lat.value).toBe('51.5072'));
		expect(lon.value).toBe('-0.1276');
		// Units mirror the loaded config; poll seconds are shown as minutes (1800s → 30min).
		const unit = container.querySelector('select') as HTMLSelectElement;
		expect(unit.value).toBe('fahrenheit');
		const poll = container.querySelector('input[type="number"]') as HTMLInputElement;
		expect(poll.value).toBe('30');
		expect(getByText('configured')).toBeTruthy();
		// The studio panel kicks the poll task so the badge has a live status to read.
		expect(weatherConnect).toHaveBeenCalled();
	});

	it('shows "not configured" when the status is unconfigured', async () => {
		vi.mocked(weatherConfigStatus).mockResolvedValue({
			configured: false,
			latitude: 0,
			longitude: 0,
			unit: 'celsius',
			pollSeconds: 900
		});
		const { findByText, container } = renderPanel();
		expect(await findByText('not configured')).toBeTruthy();
		// Falsy lat/lon (0) round-trip to empty fields; default unit + 900s → 15min.
		const lat = container.querySelector('input[placeholder="51.5072"]') as HTMLInputElement;
		expect(lat.value).toBe('');
		const poll = container.querySelector('input[type="number"]') as HTMLInputElement;
		await waitFor(() => expect(poll.value).toBe('15'));
	});

	it('updates the latitude input as the user types', async () => {
		const { container } = renderPanel();
		const lat = container.querySelector('input[placeholder="51.5072"]') as HTMLInputElement;
		await waitFor(() => expect(lat.value).toBe('51.5072'));
		fireEvent.change(lat, { target: { value: '40.7128' } });
		expect(lat.value).toBe('40.7128');
	});

	it('flags an out-of-range latitude and disables Save', async () => {
		const { container, getByRole } = renderPanel();
		const lat = container.querySelector('input[placeholder="51.5072"]') as HTMLInputElement;
		await waitFor(() => expect(lat.value).toBe('51.5072'));
		fireEvent.change(lat, { target: { value: '999' } });
		expect(lat.getAttribute('aria-invalid')).toBe('true');
		const save = getByRole('button', { name: /Save & fetch/ });
		expect(save.hasAttribute('disabled')).toBe(true);
		// A bad value must not reach the backend.
		fireEvent.click(save);
		expect(saveWeatherConfig).not.toHaveBeenCalled();
	});

	it('flags an out-of-range longitude', async () => {
		const { container } = renderPanel();
		const lon = container.querySelector('input[placeholder="-0.1276"]') as HTMLInputElement;
		await waitFor(() => expect(lon.value).toBe('-0.1276'));
		fireEvent.change(lon, { target: { value: '-500' } });
		expect(lon.getAttribute('aria-invalid')).toBe('true');
	});

	it('saves the parsed numeric config (minutes → seconds) then restarts the task in order', async () => {
		const { container, getByRole } = renderPanel();
		const lat = container.querySelector('input[placeholder="51.5072"]') as HTMLInputElement;
		await waitFor(() => expect(lat.value).toBe('51.5072'));
		const unit = container.querySelector('select') as HTMLSelectElement;
		fireEvent.change(unit, { target: { value: 'celsius' } });
		const poll = container.querySelector('input[type="number"]') as HTMLInputElement;
		fireEvent.change(poll, { target: { value: '20' } });

		fireEvent.click(getByRole('button', { name: /Save & fetch/ }));

		await waitFor(() =>
			expect(saveWeatherConfig).toHaveBeenCalledWith({
				latitude: 51.5072,
				longitude: -0.1276,
				unit: 'celsius',
				pollSeconds: 1200 // 20 minutes
			})
		);
		await waitFor(() => expect(weatherDisconnect).toHaveBeenCalled());
		// Restart order: save → disconnect → connect (the running task holds the old config).
		const save = vi.mocked(saveWeatherConfig).mock.invocationCallOrder[0];
		const disc = vi.mocked(weatherDisconnect).mock.invocationCallOrder[0];
		const conn = vi.mocked(weatherConnect).mock.invocationCallOrder.at(-1) as number;
		expect(save).toBeLessThan(disc);
		expect(disc).toBeLessThan(conn);
	});

	it('shows the "Saved ✓" confirmation after a successful save', async () => {
		const { container, getByRole, findByText } = renderPanel();
		const lat = container.querySelector('input[placeholder="51.5072"]') as HTMLInputElement;
		await waitFor(() => expect(lat.value).toBe('51.5072'));
		fireEvent.click(getByRole('button', { name: /Save & fetch/ }));
		expect(await findByText('Saved ✓')).toBeTruthy();
	});

	it('reflects the live weather.status sample in the badge', async () => {
		const { getByText } = renderPanel();
		await waitFor(() => expect(weatherConfigStatus).toHaveBeenCalled());
		// Default badge before any sample is "Not connected".
		expect(getByText(/Not connected/)).toBeTruthy();
		act(() => {
			hub.ingest({
				sensor: 'weather.status',
				ts_ms: 0,
				value: { kind: 'text', value: 'connected' }
			});
		});
		expect(getByText(/Connected/)).toBeTruthy();
	});

	it('auto-dismisses the "Saved ✓" tick after 2.5s', async () => {
		vi.useFakeTimers();
		try {
			const { getByRole, getByText, queryByText } = renderPanel();
			await act(async () => {}); // flush the prefill promises
			fireEvent.click(getByRole('button', { name: /Save & fetch/ }));
			await act(async () => {}); // flush the save → disconnect → connect chain
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
		vi.mocked(weatherConnect).mockRejectedValue(new Error('no backend'));
		vi.mocked(weatherConfigStatus).mockRejectedValue(new Error('no backend'));
		const { container, findByText } = renderPanel();
		// Both rejections are swallowed; the panel stays usable with its default (empty) form.
		expect(await findByText('not configured')).toBeTruthy();
		const lat = container.querySelector('input[placeholder="51.5072"]') as HTMLInputElement;
		expect(lat.value).toBe('');
	});

	it('ignores a status result that resolves after unmount (no setState on a dead panel)', async () => {
		let resolveStatus: (s: {
			configured: boolean;
			latitude: number;
			longitude: number;
			unit: string;
			pollSeconds: number;
		}) => void = () => undefined;
		vi.mocked(weatherConfigStatus).mockImplementation(
			() => new Promise((res) => (resolveStatus = res))
		);
		const { container, unmount } = renderPanel();
		const lat = container.querySelector('input[placeholder="51.5072"]') as HTMLInputElement;
		expect(lat.value).toBe('');
		unmount();
		// Resolving late must hit the `alive` guard, not a state setter on the unmounted panel.
		await act(async () => {
			resolveStatus({
				configured: true,
				latitude: 1,
				longitude: 2,
				unit: 'celsius',
				pollSeconds: 900
			});
		});
	});

	it('falls back to celsius + a 15-minute poll when the saved status has neither', async () => {
		vi.mocked(weatherConfigStatus).mockResolvedValue({
			configured: false,
			latitude: 0,
			longitude: 0,
			unit: '', // unset → the || 'celsius' fallback
			pollSeconds: 0 // unset → the || 900 fallback → 15 minutes
		});
		const { container } = renderPanel();
		await waitFor(() => expect(weatherConfigStatus).toHaveBeenCalled());
		const poll = container.querySelector('input[type="number"]') as HTMLInputElement;
		await waitFor(() => expect(poll.value).toBe('15'));
		const unit = container.querySelector('select') as HTMLSelectElement;
		expect(unit.value).toBe('celsius');
	});
});
