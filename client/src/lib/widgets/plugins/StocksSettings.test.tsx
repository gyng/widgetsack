import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

// Mock the stocks command adapter (no backend). Spies so we can assert args + the save → disconnect
// → connect → refresh ordering. Yahoo is keyless, so nothing here is secret.
vi.mock('./stocks-commands', () => ({
	stocksConfigStatus: vi.fn(() =>
		Promise.resolve({
			configured: true,
			provider: 'yahoo',
			symbols: ['AAPL', 'BTC-USD'],
			pollSeconds: 90
		})
	),
	saveStocksConfig: vi.fn(() => Promise.resolve()),
	stocksConnect: vi.fn(() => Promise.resolve()),
	stocksDisconnect: vi.fn(() => Promise.resolve())
}));
// Mock the source so the bindable-id list is deterministic and refreshStocksCatalog is observable.
vi.mock('./stocks-source', () => ({
	refreshStocksCatalog: vi.fn(() => Promise.resolve(['AAPL', 'BTC-USD'])),
	stocksSource: {
		catalogEntries: vi.fn(() => [
			{ id: 'stocks.AAPL.price', label: 'AAPL price' },
			{ id: 'stocks.AAPL.change', label: 'AAPL change', unit: '%' }
		])
	}
}));
vi.mock('../../overlay', () => ({ copyToClipboard: vi.fn(() => Promise.resolve(true)) }));

import StocksSettings from './StocksSettings';
import {
	saveStocksConfig,
	stocksConfigStatus,
	stocksConnect,
	stocksDisconnect
} from './stocks-commands';
import { refreshStocksCatalog, stocksSource } from './stocks-source';
import { copyToClipboard } from '../../overlay';
import { createTelemetryHub, type TelemetryHub } from '../../core/telemetry';
import { TelemetryHubContext } from '../telemetryContext';

let hub: TelemetryHub;

function renderPanel() {
	hub = createTelemetryHub();
	return render(
		<TelemetryHubContext.Provider value={hub}>
			<StocksSettings />
		</TelemetryHubContext.Provider>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(stocksConfigStatus).mockResolvedValue({
		configured: true,
		provider: 'yahoo',
		symbols: ['AAPL', 'BTC-USD'],
		pollSeconds: 90
	});
});

describe('StocksSettings', () => {
	it('prefills the symbol chips + poll interval from stocks_config_status', async () => {
		const { findByLabelText, getByLabelText, container, getByText } = renderPanel();
		// Tickers arrive as chips in the TokenListField — each chip has a unique remove button
		// (the symbol names also appear in the help blurb, so target the chips directly).
		expect(await findByLabelText('Remove AAPL')).toBeTruthy();
		expect(getByLabelText('Remove BTC-USD')).toBeTruthy();
		const poll = container.querySelector('input[type="number"]') as HTMLInputElement;
		await waitFor(() => expect(poll.value).toBe('90'));
		expect(getByText('configured')).toBeTruthy();
		// The live feed is started in the studio window for the badge.
		expect(stocksConnect).toHaveBeenCalled();
	});

	it('lists the bindable per-symbol sensor ids', async () => {
		const { findByText, getByText } = renderPanel();
		expect(await findByText('AAPL price')).toBeTruthy();
		expect(getByText('stocks.AAPL.price')).toBeTruthy();
		expect(getByText('stocks.AAPL.change')).toBeTruthy();
	});

	it('adds a ticker chip via the token field and removes it', async () => {
		const { findByText, getByLabelText, queryByText } = renderPanel();
		await findByText('AAPL price'); // wait for prefill (sensor list is unambiguous)
		const add = getByLabelText('Add Tickers') as HTMLInputElement;
		fireEvent.change(add, { target: { value: 'msft' } });
		fireEvent.keyDown(add, { key: 'Enter' });
		// parseSymbols upper-cases, so the chip shows MSFT.
		expect(await findByText('MSFT')).toBeTruthy();
		fireEvent.click(getByLabelText('Remove MSFT'));
		expect(queryByText('MSFT')).toBeNull();
	});

	it('edits the poll interval', async () => {
		const { container, findByText } = renderPanel();
		await findByText('AAPL price'); // wait for prefill (sensor list is unambiguous)
		const poll = container.querySelector('input[type="number"]') as HTMLInputElement;
		await waitFor(() => expect(poll.value).toBe('90'));
		fireEvent.change(poll, { target: { value: '120' } });
		expect(poll.value).toBe('120');
	});

	it('saves the symbols + interval then restarts in order (save → disconnect → connect → refresh)', async () => {
		const { getByText, findByText } = renderPanel();
		await findByText('AAPL price'); // wait for prefill (sensor list is unambiguous)
		fireEvent.click(getByText('Save & refresh'));

		await waitFor(() =>
			expect(saveStocksConfig).toHaveBeenCalledWith({
				provider: 'yahoo',
				symbols: ['AAPL', 'BTC-USD'],
				pollSeconds: 90
			})
		);
		await waitFor(() => expect(stocksDisconnect).toHaveBeenCalled());
		await waitFor(() => expect(refreshStocksCatalog).toHaveBeenCalled());
		const save = vi.mocked(saveStocksConfig).mock.invocationCallOrder[0];
		const disc = vi.mocked(stocksDisconnect).mock.invocationCallOrder[0];
		const conn = vi.mocked(stocksConnect).mock.invocationCallOrder.at(-1) as number;
		const refresh = vi.mocked(refreshStocksCatalog).mock.invocationCallOrder.at(-1) as number;
		expect(save).toBeLessThan(disc);
		expect(disc).toBeLessThan(conn);
		expect(conn).toBeLessThan(refresh);
		expect(await findByText('Saved ✓')).toBeTruthy();
	});

	it('surfaces a save error instead of swallowing it', async () => {
		vi.mocked(saveStocksConfig).mockRejectedValueOnce(new Error('disk full'));
		const { getByText, findByText, queryByText } = renderPanel();
		await findByText('AAPL price'); // wait for prefill (sensor list is unambiguous)
		fireEvent.click(getByText('Save & refresh'));
		expect(await findByText(/Couldn.t save: disk full/)).toBeTruthy();
		expect(queryByText('Saved ✓')).toBeNull();
	});

	it('copies a bindable sensor id', async () => {
		const { findByText, getByLabelText } = renderPanel();
		await findByText('AAPL price');
		fireEvent.click(getByLabelText('Copy sensor id stocks.AAPL.price'));
		expect(copyToClipboard).toHaveBeenCalledWith('stocks.AAPL.price');
	});

	it('shows the empty-symbols hint when no tickers are configured', async () => {
		vi.mocked(stocksConfigStatus).mockResolvedValueOnce({
			configured: false,
			provider: 'yahoo',
			symbols: [],
			pollSeconds: 60
		});
		const { findByText, getByText } = renderPanel();
		expect(await findByText('not configured')).toBeTruthy();
		expect(getByText(/No symbols yet/)).toBeTruthy();
	});

	it('reflects the live stocks.status sample in the badge', async () => {
		const { getByText } = renderPanel();
		await waitFor(() => expect(stocksConfigStatus).toHaveBeenCalled());
		act(() => {
			hub.ingest({
				sensor: 'stocks.status',
				ts_ms: 0,
				value: { kind: 'text', value: 'connected' }
			});
		});
		expect(getByText(/Connected/)).toBeTruthy();
	});

	it('auto-dismisses the "Saved ✓" tick after 2.5s', async () => {
		vi.useFakeTimers();
		try {
			const { getByText, queryByText } = renderPanel();
			await act(async () => {}); // flush the prefill promises
			fireEvent.click(getByText('Save & refresh'));
			await act(async () => {}); // flush the save → disconnect → connect → refresh chain
			expect(getByText('Saved ✓')).toBeTruthy();
			act(() => {
				vi.advanceTimersByTime(2500);
			});
			expect(queryByText('Saved ✓')).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('stringifies a non-Error save failure', async () => {
		vi.mocked(saveStocksConfig).mockRejectedValueOnce('quota exceeded');
		const { getByText, findByText } = renderPanel();
		await findByText('AAPL price'); // wait for prefill (sensor list is unambiguous)
		fireEvent.click(getByText('Save & refresh'));
		expect(await findByText(/Couldn.t save: quota exceeded/)).toBeTruthy();
	});

	it('renders with defaults when the connect kick and the status fetch both reject', async () => {
		vi.mocked(stocksConnect).mockRejectedValue(new Error('no backend'));
		vi.mocked(stocksConfigStatus).mockRejectedValue(new Error('no backend'));
		const { findByText, container } = renderPanel();
		// Both rejections are swallowed; the panel stays usable with its defaults.
		expect(await findByText('not configured')).toBeTruthy();
		const poll = container.querySelector('input[type="number"]') as HTMLInputElement;
		expect(poll.value).toBe('60');
	});

	it('ignores a status result that resolves after unmount (no setState on a dead panel)', async () => {
		type Status = Awaited<ReturnType<typeof stocksConfigStatus>>;
		let resolveStatus: (s: Status) => void = () => undefined;
		vi.mocked(stocksConfigStatus).mockImplementation(
			() => new Promise((res) => (resolveStatus = res))
		);
		const { unmount, queryByLabelText } = renderPanel();
		expect(queryByLabelText('Remove AAPL')).toBeNull();
		unmount();
		// Resolving late must hit the `alive` guard, not a state setter on the unmounted panel.
		await act(async () => {
			resolveStatus({ configured: true, provider: 'yahoo', symbols: ['AAPL'], pollSeconds: 60 });
		});
	});

	it('falls back to a 60s poll when the interval field is cleared', async () => {
		const { container, getByText, findByText } = renderPanel();
		await findByText('AAPL price'); // wait for prefill
		const poll = container.querySelector('input[type="number"]') as HTMLInputElement;
		fireEvent.change(poll, { target: { value: '' } }); // Number('') → 0 → the || 60 fallback
		fireEvent.click(getByText('Save & refresh'));
		await waitFor(() =>
			expect(saveStocksConfig).toHaveBeenCalledWith(expect.objectContaining({ pollSeconds: 60 }))
		);
	});

	it('falls back to the id when a catalog entry has no label', async () => {
		vi.mocked(stocksSource.catalogEntries!).mockReturnValue([{ id: 'stocks.MSFT.price' }]);
		const { findByText } = renderPanel();
		// The label-less entry renders its id as the name (e.label ?? e.id).
		const name = await findByText('stocks.MSFT.price', { selector: '.has-entity-name' });
		expect(name).toBeTruthy();
	});

	it('renders an empty sensor list when the source exposes no catalog', async () => {
		// A source without catalogEntries is legal (the field is optional) — the panel's `?? []`
		// degrades to an empty id list rather than crashing.
		const src = stocksSource as { catalogEntries?: () => { id: string; label?: string }[] };
		const orig = src.catalogEntries;
		src.catalogEntries = undefined;
		try {
			const { findByLabelText, container } = renderPanel();
			await findByLabelText('Remove AAPL'); // prefill: symbols present but no catalog ids
			expect(container.querySelectorAll('.has-entity').length).toBe(0);
		} finally {
			src.catalogEntries = orig;
		}
	});
});
