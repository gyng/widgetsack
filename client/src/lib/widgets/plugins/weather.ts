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
					sensors: (config) => {
						// The forecast strip subscribes weather.day.N.* for the configured days (backend ≤7).
						const map: Record<string, string> = {
							temp: 'weather.temp',
							apparent: 'weather.apparent',
							humidity: 'weather.humidity',
							wind: 'weather.wind',
							code: 'weather.code',
							is_day: 'weather.is_day',
							high: 'weather.high',
							low: 'weather.low',
							unit: 'weather.unit'
						};
						const days = Math.max(0, Math.min(7, Math.floor(Number(config?.forecastDays ?? 0))));
						for (let i = 0; i < days; i++) {
							map[`d${i}high`] = `weather.day.${i}.high`;
							map[`d${i}low`] = `weather.day.${i}.low`;
							map[`d${i}code`] = `weather.day.${i}.code`;
						}
						return map;
					},
					label: 'Weather',
					defaultSize: { w: 220, h: 160 },
					defaultConfig: { showHiLo: true, showDetail: true, forecastDays: 5 },
					configFields: [
						{ key: 'showHiLo', label: 'today high / low', kind: 'toggle' },
						{
							key: 'showDetail',
							label: 'feels-like / humidity / wind',
							kind: 'toggle'
						},
						{
							key: 'forecastDays',
							label: 'forecast days',
							kind: 'number',
							min: 0,
							max: 7,
							step: 1,
							help: 'how many days of forecast to show below (0 = off; up to 7)'
						},
						{ key: 'color', label: 'accent', kind: 'color' }
					]
				},
				component: asMeter(Weather)
			}
		]
	});
