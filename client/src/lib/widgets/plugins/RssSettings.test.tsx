import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

// Mock the RSS Tauri command adapter so the panel runs without a backend. Each fn is a spy so we
// can assert call args + ordering (Save must save → disconnect → connect to apply the new config
// to the running poll task). Public feeds — nothing here is secret.
vi.mock('./rss-commands', () => ({
	rssConfigStatus: vi.fn(() =>
		Promise.resolve({
			configured: true,
			url: 'https://example.com/feed.xml',
			count: 12,
			title: 'My Headlines',
			pollSeconds: 1800
		})
	),
	saveRssConfig: vi.fn(() => Promise.resolve()),
	rssConnect: vi.fn(() => Promise.resolve()),
	rssDisconnect: vi.fn(() => Promise.resolve())
}));

import RssSettings from './RssSettings';
import { rssConfigStatus, rssConnect, rssDisconnect, saveRssConfig } from './rss-commands';
import { createTelemetryHub, type TelemetryHub } from '../../core/telemetry';
import { TelemetryHubContext } from '../telemetryContext';

let hub: TelemetryHub;

function renderPanel() {
	hub = createTelemetryHub();
	return render(
		<TelemetryHubContext.Provider value={hub}>
			<RssSettings />
		</TelemetryHubContext.Provider>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(rssConfigStatus).mockResolvedValue({
		configured: true,
		url: 'https://example.com/feed.xml',
		count: 12,
		title: 'My Headlines',
		pollSeconds: 1800
	});
});

describe('RssSettings', () => {
	it('prefills every field from rss_config_status (pollSeconds → minutes)', async () => {
		const { container, getByText } = renderPanel();
		const url = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('https://example.com/feed.xml'));
		const texts = container.querySelectorAll('input[type="text"]');
		expect((texts[1] as HTMLInputElement).value).toBe('My Headlines'); // title
		const numbers = container.querySelectorAll('input[type="number"]');
		expect((numbers[0] as HTMLInputElement).value).toBe('12'); // headline count
		expect((numbers[1] as HTMLInputElement).value).toBe('30'); // 1800s / 60 = 30 min
		// "configured" state reflected next to the badge.
		expect(getByText('configured')).toBeTruthy();
		// The live feed is started in the studio window for the badge.
		expect(rssConnect).toHaveBeenCalled();
	});

	it('shows "not configured" when status reports it, defaulting empty/zero fields', async () => {
		vi.mocked(rssConfigStatus).mockResolvedValueOnce({
			configured: false,
			url: '',
			count: 0, // falsy → default 8
			title: '',
			pollSeconds: 0 // falsy → default 900 → 15 min
		});
		const { container, getByText } = renderPanel();
		await waitFor(() => expect(getByText('not configured')).toBeTruthy());
		const numbers = container.querySelectorAll('input[type="number"]');
		expect((numbers[0] as HTMLInputElement).value).toBe('8'); // default headline count
		expect((numbers[1] as HTMLInputElement).value).toBe('15'); // default 900s / 60
	});

	it('edits update the inputs', async () => {
		const { container } = renderPanel();
		const url = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('https://example.com/feed.xml'));
		fireEvent.change(url, { target: { value: 'https://other.test/rss' } });
		expect(url.value).toBe('https://other.test/rss');
		const count = container.querySelectorAll('input[type="number"]')[0] as HTMLInputElement;
		fireEvent.change(count, { target: { value: '5' } });
		expect(count.value).toBe('5');
	});

	it('unmounting before rss_config_status resolves does not set state (alive guard)', async () => {
		let resolve!: (v: {
			configured: boolean;
			url: string;
			count: number;
			title: string;
			pollSeconds: number;
		}) => void;
		vi.mocked(rssConfigStatus).mockReturnValueOnce(new Promise((r) => (resolve = r)));
		const { unmount } = renderPanel();
		unmount();
		await act(async () => {
			resolve({ configured: true, url: 'x', count: 1, title: 't', pollSeconds: 60 });
		});
		// No throw / no act warning means the !alive early-return fired.
		expect(rssConfigStatus).toHaveBeenCalled();
	});

	it('edits to the title and refresh (minutes) inputs update them too', async () => {
		const { container } = renderPanel();
		const url = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('https://example.com/feed.xml'));
		const title = container.querySelectorAll('input[type="text"]')[1] as HTMLInputElement;
		fireEvent.change(title, { target: { value: 'Top Stories' } });
		expect(title.value).toBe('Top Stories');
		const poll = container.querySelectorAll('input[type="number"]')[1] as HTMLInputElement;
		fireEvent.change(poll, { target: { value: '20' } });
		expect(poll.value).toBe('20');
	});

	it('flags an invalid (non-http) URL and disables Save', async () => {
		const { container, getByText, queryByText } = renderPanel();
		const url = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('https://example.com/feed.xml'));
		expect(queryByText(/Enter a full http/)).toBeNull(); // valid to start
		fireEvent.change(url, { target: { value: 'ftp://nope' } });
		expect(getByText(/Enter a full http/)).toBeTruthy();
		expect(url.getAttribute('aria-invalid')).toBe('true');
		expect((getByText('Save & fetch') as HTMLButtonElement).disabled).toBe(true);
	});

	it('saves (clamping count + minutes→seconds) then restarts in order (save → disconnect → connect)', async () => {
		const { container, getByText } = renderPanel();
		const url = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('https://example.com/feed.xml'));
		// Push count past its max (30) to prove the clamp on save.
		const count = container.querySelectorAll('input[type="number"]')[0] as HTMLInputElement;
		fireEvent.change(count, { target: { value: '99' } });
		fireEvent.click(getByText('Save & fetch'));

		await waitFor(() =>
			expect(saveRssConfig).toHaveBeenCalledWith({
				url: 'https://example.com/feed.xml',
				count: 30, // clamped to the 1..30 range
				title: 'My Headlines',
				pollSeconds: 1800 // 30 min × 60
			})
		);
		await waitFor(() => expect(rssDisconnect).toHaveBeenCalled());
		// disconnect-first is mandatory so the new config replaces the running task.
		const save = vi.mocked(saveRssConfig).mock.invocationCallOrder[0];
		const disc = vi.mocked(rssDisconnect).mock.invocationCallOrder[0];
		const conn = vi.mocked(rssConnect).mock.invocationCallOrder.at(-1) as number;
		expect(save).toBeLessThan(disc);
		expect(disc).toBeLessThan(conn);
		expect(await waitFor(() => getByText('Saved ✓'))).toBeTruthy();
	});

	it('does not save while the URL is invalid', async () => {
		const { container, getByText } = renderPanel();
		const url = container.querySelector('input[type="text"]') as HTMLInputElement;
		await waitFor(() => expect(url.value).toBe('https://example.com/feed.xml'));
		fireEvent.change(url, { target: { value: 'not-a-url' } });
		// The disabled button still fires onClick in jsdom/happy-dom; the guard must short-circuit.
		fireEvent.click(getByText('Save & fetch'));
		await waitFor(() => expect(rssConfigStatus).toHaveBeenCalled());
		expect(saveRssConfig).not.toHaveBeenCalled();
	});

	it('reflects the live rss.status sample in the badge', async () => {
		const { getByText } = renderPanel();
		await waitFor(() => expect(rssConfigStatus).toHaveBeenCalled());
		act(() => {
			hub.ingest({ sensor: 'rss.status', ts_ms: 0, value: { kind: 'text', value: 'connected' } });
		});
		expect(getByText(/Connected/)).toBeTruthy();
	});
});
