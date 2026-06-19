import { describe, expect, it, vi } from 'vitest';

// The settings panel + source call Tauri (no runtime in tests) — stub the command module + clipboard.
vi.mock('./stocks-commands', () => ({
	stocksConfigStatus: () =>
		Promise.resolve({ configured: false, provider: 'yahoo', symbols: [], pollSeconds: 60 }),
	saveStocksConfig: () => Promise.resolve(),
	stocksConnect: () => Promise.resolve(),
	stocksDisconnect: () => Promise.resolve()
}));
vi.mock('../../overlay', () => ({ copyToClipboard: () => Promise.resolve(true) }));

import { registerStocksPlugin } from './stocks';
import { listPlugins } from '../plugin';
import { sourceCatalogEntries } from '../../core/plugin';
import { configCompleteness, getMeta } from '../../core/widget';

// Registers the plugin + the ticker widget meta + the stocks source (was an import side-effect).
registerStocksPlugin();

describe('stocks plugin', () => {
	it('registers as a plugin with a settings panel + a stocks source', () => {
		const p = listPlugins().find((x) => x.id === 'stocks');
		expect(p).toMatchObject({ id: 'stocks', name: 'Stocks' });
		expect(p?.settings).toBeTruthy();
		expect(p?.sources?.some((s) => s.id === 'stocks')).toBe(true);
	});

	it('registers a self-sourcing ticker widget with fully UI-driven config', () => {
		const meta = getMeta('ticker');
		if (!meta) throw new Error('ticker meta not registered');
		expect(meta.binds).toBe('none');
		// No config key reachable only via the raw-JSON escape hatch.
		expect(configCompleteness(meta)).toEqual([]);
	});

	it('defaults a freshly-dropped ticker to a live symbol (NVDA)', () => {
		const meta = getMeta('ticker');
		// A working default means a dropped ticker shows a live quote at once (the poller auto-fetches
		// whatever symbol a ticker demands) rather than the "Set a symbol" placeholder.
		expect(meta?.defaultConfig?.symbol).toBe('NVDA');
	});

	it('always exposes the global stocks.status sensor in the catalog', () => {
		expect(sourceCatalogEntries().map((e) => e.id)).toContain('stocks.status');
	});

	it('the ticker sensors resolver derives stocks.<SYMBOL>.* ids, upper-cased + trimmed', () => {
		const sensors = getMeta('ticker')?.sensors as (
			c: Record<string, unknown>
		) => Record<string, string>;
		expect(typeof sensors).toBe('function');
		const map = sensors({ symbol: '  aapl ' });
		expect(map).toEqual({
			price: 'stocks.AAPL.price',
			change: 'stocks.AAPL.change',
			series: 'stocks.AAPL.series',
			currency: 'stocks.AAPL.currency',
			state: 'stocks.AAPL.state'
		});
	});

	it('the ticker sensors resolver binds nothing without a symbol', () => {
		const sensors = getMeta('ticker')?.sensors as (
			c: Record<string, unknown>
		) => Record<string, string>;
		expect(sensors({})).toEqual({});
		expect(sensors({ symbol: '   ' })).toEqual({});
	});
});
