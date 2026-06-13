// The weather data source (peer to stocks-source). A Rust proxy source: the fetch happens server-side
// (widgetsack/src/weather.rs, plugins/weather.json) and the current conditions arrive over the EXISTING
// `telemetry` event as `weather.*` samples — ingested by the unchanged hub. This source only flips
// polling on/off and provides the (fixed) bindable-id catalog for the inspector dropdown.

import type { SensorCatalogEntry, SensorSource } from '../../core/plugin';
import { weatherConnect, weatherDisconnect } from './weather-commands';

// The ids weather.rs emits (keep in sync with weather_to_samples). One location, so they're fixed.
const ENTRIES: SensorCatalogEntry[] = [
	{ id: 'weather.status', label: 'Weather status' },
	{ id: 'weather.temp', label: 'Temperature' },
	{ id: 'weather.apparent', label: 'Feels like' },
	{ id: 'weather.humidity', label: 'Humidity', unit: '%' },
	{ id: 'weather.wind', label: 'Wind speed' },
	{ id: 'weather.code', label: 'Condition code' },
	{ id: 'weather.high', label: 'Today high' },
	{ id: 'weather.low', label: 'Today low' }
];

export const weatherSource: SensorSource = {
	id: 'weather',
	start: async () => {
		await weatherConnect().catch(() => undefined);
		return () => {
			weatherDisconnect().catch(() => undefined);
		};
	},
	catalog: () => ENTRIES.map((e) => e.id),
	catalogEntries: () => ENTRIES
};
