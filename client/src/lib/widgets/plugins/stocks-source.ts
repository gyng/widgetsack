// Backend worker lifetime belongs to the app. Window cleanup releases only local subscriptions.
// The stocks data source (peer to mqtt-source / ha-source). A Rust proxy source: the fetch happens
// server-side (widgetsack/src/stocks.rs, plugins/stocks.json) and quotes arrive over the EXISTING
// `telemetry` event as `stocks.<SYMBOL>.*` samples — ingested by the unchanged hub. This source only
// ensures polling is running and provides the catalog (the configured symbols' bindable ids) for the
// inspector dropdown.

import type { SensorCatalogEntry, SensorSource } from '../../core/plugin';
import { stocksConfigStatus, stocksConnect } from './stocks-commands';

let symbols: string[] = [];

// The per-symbol ids worth surfacing in the dropdown (Text/Gauge/Sparkline-bindable). `.series` is a
// real intraday array; `.price` also accumulates a history ring, so either drives a Sparkline.
// Mirrors the per-symbol ids emitted by quote_to_samples in widgetsack/src/stocks.rs — keep in sync.
const FIELDS: { suffix: string; label: string; unit?: string }[] = [
	{ suffix: 'price', label: 'price' },
	{ suffix: 'change', label: 'change', unit: '%' },
	{ suffix: 'changeAbs', label: 'change (abs)' },
	{ suffix: 'prevClose', label: 'prev close' },
	{ suffix: 'currency', label: 'currency' },
	{ suffix: 'state', label: 'market state' },
	{ suffix: 'series', label: 'intraday' }
];

function entriesFor(syms: string[]): SensorCatalogEntry[] {
	const out: SensorCatalogEntry[] = [{ id: 'stocks.status', label: 'Stocks status' }];
	for (const raw of syms) {
		const sym = raw.trim().toUpperCase();
		if (!sym) continue;
		for (const f of FIELDS) {
			out.push({ id: `stocks.${sym}.${f.suffix}`, label: `${sym} ${f.label}`, unit: f.unit });
		}
	}
	return out;
}

/** Re-read the configured symbol list (drives the catalog). Silent on failure (not configured). */
export async function refreshStocksCatalog(): Promise<string[]> {
	try {
		symbols = (await stocksConfigStatus()).symbols ?? [];
	} catch {
		// not configured / unavailable: keep the prior list
	}
	return symbols;
}

export const stocksSource: SensorSource = {
	id: 'stocks',
	start: async () => {
		await refreshStocksCatalog();
		await stocksConnect().catch(() => undefined);
		return () => undefined;
	},
	catalog: () => entriesFor(symbols).map((e) => e.id),
	catalogEntries: () => entriesFor(symbols)
};
