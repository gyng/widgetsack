import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

// Mock the Agenda Tauri command adapter so the panel runs without a backend. Each fn is a spy so we can
// assert call args + ordering (Save must save → disconnect → connect). The feed is a public ICS URL —
// nothing secret.
vi.mock('./agenda-commands', () => ({
	agendaConfigStatus: vi.fn(() =>
		Promise.resolve({
			configured: true,
			url: 'https://calendar.example.com/basic.ics',
			title: 'Work',
			pollSeconds: 1800
		})
	),
	saveAgendaConfig: vi.fn(() => Promise.resolve()),
	agendaConnect: vi.fn(() => Promise.resolve()),
	agendaDisconnect: vi.fn(() => Promise.resolve())
}));

import AgendaSettings from './AgendaSettings';
import {
	agendaConfigStatus,
	agendaConnect,
	agendaDisconnect,
	saveAgendaConfig
} from './agenda-commands';
import { createTelemetryHub, type TelemetryHub } from '../../core/telemetry';
import { TelemetryHubContext } from '../telemetryContext';

let hub: TelemetryHub;

function renderPanel() {
	hub = createTelemetryHub();
	return render(
		<TelemetryHubContext.Provider value={hub}>
			<AgendaSettings />
		</TelemetryHubContext.Provider>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(agendaConfigStatus).mockResolvedValue({
		configured: true,
		url: 'https://calendar.example.com/basic.ics',
		title: 'Work',
		pollSeconds: 1800
	});
});

describe('AgendaSettings', () => {
	it('prefills the form from agenda_config_status and starts the live feed', async () => {
		const { container, getByText } = renderPanel();
		const url = container.querySelector('input[inputmode="url"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('https://calendar.example.com/basic.ics'));
		const title = container.querySelector('input[placeholder="Agenda"]') as HTMLInputElement;
		expect(title.value).toBe('Work');
		// pollSeconds is shown as minutes (1800s → 30min).
		const poll = container.querySelector('input[type="number"]') as HTMLInputElement;
		expect(poll.value).toBe('30');
		expect(getByText('configured')).toBeTruthy();
		// The studio panel kicks the poll task so the badge has a live status to read.
		expect(agendaConnect).toHaveBeenCalled();
	});

	it('shows "not configured" with an empty URL when unconfigured', async () => {
		vi.mocked(agendaConfigStatus).mockResolvedValue({
			configured: false,
			url: '',
			title: '',
			pollSeconds: 1800
		});
		const { findByText, container } = renderPanel();
		expect(await findByText('not configured')).toBeTruthy();
		const url = container.querySelector('input[inputmode="url"]') as HTMLInputElement;
		expect(url.value).toBe('');
	});

	it('updates the URL input as the user types', async () => {
		const { container } = renderPanel();
		const url = container.querySelector('input[inputmode="url"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('https://calendar.example.com/basic.ics'));
		fireEvent.change(url, { target: { value: 'https://other.example/cal.ics' } });
		expect(url.value).toBe('https://other.example/cal.ics');
	});

	it('flags a non-URL value and disables Save', async () => {
		const { container, getByRole } = renderPanel();
		const url = container.querySelector('input[inputmode="url"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('https://calendar.example.com/basic.ics'));
		fireEvent.change(url, { target: { value: 'not-a-url' } });
		expect(url.getAttribute('aria-invalid')).toBe('true');
		const save = getByRole('button', { name: /Save & fetch/ });
		expect(save.hasAttribute('disabled')).toBe(true);
		// A bad URL must not reach the backend.
		fireEvent.click(save);
		expect(saveAgendaConfig).not.toHaveBeenCalled();
	});

	it('accepts a webcal:// URL as valid', async () => {
		const { container, getByRole } = renderPanel();
		const url = container.querySelector('input[inputmode="url"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('https://calendar.example.com/basic.ics'));
		fireEvent.change(url, { target: { value: 'webcal://cal.example/feed.ics' } });
		expect(url.getAttribute('aria-invalid')).toBe('false');
		expect(getByRole('button', { name: /Save & fetch/ }).hasAttribute('disabled')).toBe(false);
	});

	it('saves the trimmed config (minutes → seconds) then restarts the task in order', async () => {
		const { container, getByRole } = renderPanel();
		const url = container.querySelector('input[inputmode="url"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('https://calendar.example.com/basic.ics'));
		// Leading/trailing whitespace is trimmed before it crosses the bridge.
		fireEvent.change(url, { target: { value: '  https://new.example/feed.ics  ' } });
		const title = container.querySelector('input[placeholder="Agenda"]') as HTMLInputElement;
		fireEvent.change(title, { target: { value: 'Personal' } });
		const poll = container.querySelector('input[type="number"]') as HTMLInputElement;
		fireEvent.change(poll, { target: { value: '45' } });

		fireEvent.click(getByRole('button', { name: /Save & fetch/ }));

		await waitFor(() =>
			expect(saveAgendaConfig).toHaveBeenCalledWith({
				url: 'https://new.example/feed.ics',
				title: 'Personal',
				pollSeconds: 2700 // 45 minutes
			})
		);
		await waitFor(() => expect(agendaDisconnect).toHaveBeenCalled());
		// Restart order: save → disconnect → connect (the running task holds the old config).
		const save = vi.mocked(saveAgendaConfig).mock.invocationCallOrder[0];
		const disc = vi.mocked(agendaDisconnect).mock.invocationCallOrder[0];
		const conn = vi.mocked(agendaConnect).mock.invocationCallOrder.at(-1) as number;
		expect(save).toBeLessThan(disc);
		expect(disc).toBeLessThan(conn);
	});

	it('shows the "Saved ✓" confirmation after a successful save', async () => {
		const { container, getByRole, findByText } = renderPanel();
		const url = container.querySelector('input[inputmode="url"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('https://calendar.example.com/basic.ics'));
		fireEvent.click(getByRole('button', { name: /Save & fetch/ }));
		expect(await findByText('Saved ✓')).toBeTruthy();
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
		vi.mocked(agendaConnect).mockRejectedValue(new Error('no backend'));
		vi.mocked(agendaConfigStatus).mockRejectedValue(new Error('no backend'));
		const { container, findByText } = renderPanel();
		// Both rejections are swallowed; the panel stays usable with its default (empty) form.
		expect(await findByText('not configured')).toBeTruthy();
		const url = container.querySelector('input[inputmode="url"]') as HTMLInputElement;
		expect(url.value).toBe('');
	});

	it('ignores a status result that resolves after unmount (no setState on a dead panel)', async () => {
		let resolveStatus: (s: {
			configured: boolean;
			url: string;
			title: string;
			pollSeconds: number;
		}) => void = () => undefined;
		vi.mocked(agendaConfigStatus).mockImplementation(
			() => new Promise((res) => (resolveStatus = res))
		);
		const { container, unmount } = renderPanel();
		const url = container.querySelector('input[inputmode="url"]') as HTMLInputElement;
		expect(url.value).toBe('');
		unmount();
		// Resolving late must hit the `alive` guard, not a state setter on the unmounted panel.
		await act(async () => {
			resolveStatus({
				configured: true,
				url: 'https://x.example/a.ics',
				title: 't',
				pollSeconds: 60
			});
		});
	});

	it('falls back to a 30-minute poll when the saved status has no pollSeconds', async () => {
		vi.mocked(agendaConfigStatus).mockResolvedValue({
			configured: true,
			url: 'https://calendar.example.com/basic.ics',
			title: '',
			pollSeconds: 0 // unset/zero → the || 1800 fallback → 30 minutes
		});
		const { container } = renderPanel();
		const poll = container.querySelector('input[type="number"]') as HTMLInputElement;
		await waitFor(() => expect(poll.value).toBe('30'));
	});

	it('reflects the live agenda.status sample in the badge', async () => {
		const { getByText } = renderPanel();
		await waitFor(() => expect(agendaConfigStatus).toHaveBeenCalled());
		// Default badge before any sample is "Not connected".
		expect(getByText(/Not connected/)).toBeTruthy();
		act(() => {
			hub.ingest({ sensor: 'agenda.status', ts_ms: 0, value: { kind: 'text', value: 'error' } });
		});
		expect(getByText(/Error/)).toBeTruthy();
	});
});
