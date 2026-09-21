import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

// Mock the Agenda Tauri command adapter so the panel runs without a backend. Each fn is a spy so we can
// assert call args + ordering (Save must save → disconnect → connect). The feed URL is a secret held
// write-only: the status carries only its host, and a blank field on save keeps the saved feed.
vi.mock('./agenda-commands', () => ({
	agendaConfigStatus: vi.fn(() =>
		Promise.resolve({
			configured: true,
			host: 'calendar.example.com',
			title: 'Work',
			pollSeconds: 1800
		})
	),
	saveAgendaConfig: vi.fn(() => Promise.resolve()),
	agendaConnect: vi.fn(() => Promise.resolve()),
	agendaDisconnect: vi.fn(() => Promise.resolve())
}));

import AgendaSettings, { hostOf } from './AgendaSettings';
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
		host: 'calendar.example.com',
		title: 'Work',
		pollSeconds: 1800
	});
});

describe('hostOf', () => {
	it('extracts the hostname from https and webcal feeds, empty when unparseable', () => {
		expect(hostOf('https://calendar.google.com/calendar/ical/x/basic.ics')).toBe(
			'calendar.google.com'
		);
		expect(hostOf('webcal://cal.example/feed.ics')).toBe('cal.example');
		expect(hostOf('not a url')).toBe('');
	});
});

describe('AgendaSettings', () => {
	it('prefills the form from agenda_config_status (URL stays blank, host in the placeholder) and starts the live feed', async () => {
		const { container, getByText } = renderPanel();
		const url = container.querySelector('input[inputmode="url"]') as HTMLInputElement;
		await waitFor(() => expect(url.placeholder).toContain('saved (calendar.example.com)'));
		expect(url.value).toBe(''); // the secret is never read back
		expect(url.type).toBe('password');
		const title = container.querySelector('input[placeholder="Agenda"]') as HTMLInputElement;
		expect(title.value).toBe('Work');
		// pollSeconds is shown as minutes (1800s → 30min).
		const poll = container.querySelector('input[type="number"]') as HTMLInputElement;
		expect(poll.value).toBe('30');
		expect(getByText('configured')).toBeTruthy();
		// The studio panel kicks the poll task so the badge has a live status to read.
		expect(agendaConnect).toHaveBeenCalled();
	});

	it('shows "not configured" with an empty URL (and a URL-shaped placeholder) when unconfigured; Save is disabled until a URL is typed', async () => {
		vi.mocked(agendaConfigStatus).mockResolvedValue({
			configured: false,
			host: '',
			title: '',
			pollSeconds: 1800
		});
		const { findByText, container, getByRole } = renderPanel();
		expect(await findByText('not configured')).toBeTruthy();
		const url = container.querySelector('input[inputmode="url"]') as HTMLInputElement;
		expect(url.value).toBe('');
		expect(url.placeholder).toContain('https://');
		// no saved feed + blank field → nothing to keep → Save stays disabled
		expect(getByRole('button', { name: /Save & fetch/ }).hasAttribute('disabled')).toBe(true);
	});

	it('updates the URL input as the user types', async () => {
		const { container } = renderPanel();
		const url = container.querySelector('input[inputmode="url"]') as HTMLInputElement;
		await waitFor(() => expect(url.placeholder).toContain('saved'));
		fireEvent.change(url, { target: { value: 'https://other.example/cal.ics' } });
		expect(url.value).toBe('https://other.example/cal.ics');
	});

	it('flags a non-URL value and disables Save', async () => {
		const { container, getByRole } = renderPanel();
		const url = container.querySelector('input[inputmode="url"]') as HTMLInputElement;
		await waitFor(() => expect(url.placeholder).toContain('saved'));
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
		await waitFor(() => expect(url.placeholder).toContain('saved'));
		fireEvent.change(url, { target: { value: 'webcal://cal.example/feed.ics' } });
		expect(url.getAttribute('aria-invalid')).toBe('false');
		expect(getByRole('button', { name: /Save & fetch/ }).hasAttribute('disabled')).toBe(false);
	});

	it('saves the trimmed config (minutes → seconds) then restarts the task in order, clearing the field', async () => {
		const { container, getByRole } = renderPanel();
		const url = container.querySelector('input[inputmode="url"]') as HTMLInputElement;
		await waitFor(() => expect(url.placeholder).toContain('saved'));
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
		// the secret is cleared from the field and the placeholder now names the NEW host
		await waitFor(() => expect(url.value).toBe(''));
		expect(url.placeholder).toContain('saved (new.example)');
	});

	it('a blank URL on save keeps the saved feed (url: "") — the write-only contract', async () => {
		const { container, getByRole } = renderPanel();
		const url = container.querySelector('input[inputmode="url"]') as HTMLInputElement;
		await waitFor(() => expect(url.placeholder).toContain('saved'));
		const title = container.querySelector('input[placeholder="Agenda"]') as HTMLInputElement;
		fireEvent.change(title, { target: { value: 'Renamed' } });
		fireEvent.click(getByRole('button', { name: /Save & fetch/ }));
		await waitFor(() =>
			expect(saveAgendaConfig).toHaveBeenCalledWith({
				url: '',
				title: 'Renamed',
				pollSeconds: 1800
			})
		);
		expect(url.placeholder).toContain('saved (calendar.example.com)');
	});

	it('shows the "Saved ✓" confirmation after a successful save', async () => {
		const { container, getByRole, findByText } = renderPanel();
		const url = container.querySelector('input[inputmode="url"]') as HTMLInputElement;
		await waitFor(() => expect(url.placeholder).toContain('saved'));
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
			host: string;
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
				host: 'x.example',
				title: 't',
				pollSeconds: 60
			});
		});
	});

	it('falls back to a 30-minute poll when the saved status has no pollSeconds', async () => {
		vi.mocked(agendaConfigStatus).mockResolvedValue({
			configured: true,
			host: '',
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
