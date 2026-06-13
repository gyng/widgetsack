// The Weather plugin: a server-side Open-Meteo source (widgetsack/src/weather.rs), a settings panel
// (location + units), and a Weather widget. Calling `registerWeatherPlugin()` (via plugins/index.ts)
// registers the source + the settings panel + the `weather` widget type. Conditions also bind as
// `weather.*` sensors on the built-in Text / Gauge meters.

import { registerPlugin } from '../plugin';
import { weatherSource } from './weather-source';
import WeatherSettings from './WeatherSettings';
import Weather from '../meters/Weather';
import { asMeter } from '../registry';

export const registerWeatherPlugin = (): void =>
	registerPlugin({
		id: 'weather',
		name: 'Weather',
		description:
			'Local weather via Open-Meteo (keyless — no API key). Set your location in this panel, then drop a Weather widget or bind weather.* sensors.',
		sources: [weatherSource],
		settings: WeatherSettings,
		statusSensor: 'weather.status',
		widgets: [
			{
				meta: {
					// Multi-sensor (binds:'none'): the `sensors` map binds the fixed weather.* ids; WidgetHost
					// passes the meter a props-only `sensors` snapshot.
					type: 'weather',
					binds: 'none',
					sensors: () => ({
						temp: 'weather.temp',
						apparent: 'weather.apparent',
						humidity: 'weather.humidity',
						wind: 'weather.wind',
						code: 'weather.code',
						is_day: 'weather.is_day',
						high: 'weather.high',
						low: 'weather.low',
						unit: 'weather.unit'
					}),
					label: 'Weather',
					defaultSize: { w: 200, h: 110 },
					defaultConfig: { showHiLo: true, showDetail: true },
					configFields: [
						{ key: 'showHiLo', label: 'today high / low', kind: 'toggle' },
						{
							key: 'showDetail',
							label: 'feels-like / humidity / wind',
							kind: 'toggle'
						},
						{ key: 'color', label: 'accent', kind: 'color' }
					]
				},
				component: asMeter(Weather)
			}
		]
	});
