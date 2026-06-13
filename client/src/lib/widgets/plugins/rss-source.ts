// The RSS data source (peer to weather-source). A Rust proxy source: the fetch + parse happen
// server-side (widgetsack/src/rss.rs, plugins/rss.json) and the headlines arrive over the EXISTING
// `telemetry` event as an `rss.list` JSON sample — ingested by the unchanged hub. This source only
// flips polling on/off and provides the bindable-id catalog for the inspector.

import type { SensorCatalogEntry, SensorSource } from '../../core/plugin';
import { rssConnect, rssDisconnect } from './rss-commands';

const ENTRIES: SensorCatalogEntry[] = [
	{ id: 'rss.status', label: 'RSS status' },
	{ id: 'rss.count', label: 'RSS item count' }
];

export const rssSource: SensorSource = {
	id: 'rss',
	start: async () => {
		await rssConnect().catch(() => undefined);
		return () => {
			rssDisconnect().catch(() => undefined);
		};
	},
	catalog: () => ENTRIES.map((e) => e.id),
	catalogEntries: () => ENTRIES
};
