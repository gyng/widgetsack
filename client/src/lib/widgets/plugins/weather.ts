// The Weather plugin: a server-side Open-Meteo source (widgetsack/src/weather.rs), a settings panel
// (location + units), and a Weather widget. Calling `registerWeatherPlugin()` (via plugins/index.ts)
// registers the source + the settings panel + the `weather` widget type. Conditions also bind as
// `weather.*` sensors on the built-in Text / Gauge meters.

import { registerPlugin } from '../plugin';
import { weatherSource } from './weather-source';
import WeatherSettings from './WeatherSettings';
import Weather from '../meters/Weather';
import SunMoon from '../meters/SunMoon';
import AirQuality from '../meters/AirQuality';
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
							status: 'weather.status', // loading / error vs. "no location" in the empty state
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
						{
							key: 'showHiLo',
							label: 'today high / low',
							kind: 'toggle',
							group: 'Appearance',
							help: 'show today’s high / low beside the temperature (location is set in Plugins → Weather)'
						},
						{
							key: 'showDetail',
							label: 'feels-like / humidity / wind',
							kind: 'toggle',
							group: 'Appearance',
							help: 'show the feels-like temperature, humidity and wind line'
						},
						{
							key: 'forecastDays',
							label: 'forecast days',
							kind: 'number',
							min: 0,
							max: 7,
							step: 1,
							group: 'Data',
							help: 'how many days of forecast to show below (0 = off; up to 7)'
						},
						{
							key: 'color',
							label: 'accent',
							kind: 'color',
							group: 'Appearance',
							help: 'temperature / icon colour (blank = theme accent)'
						}
					]
				},
				component: asMeter(Weather)
			},
			{
				// Sun & Moon: sunrise/sunset from the weather source + a wall-clock moon phase. binds:'none',
				// multi-sensor — the sensors map binds weather.sun.{rise,set}; the moon needs no backend.
				meta: {
					type: 'sunmoon',
					binds: 'none',
					sensors: () => ({ rise: 'weather.sun.rise', set: 'weather.sun.set' }),
					label: 'Sun & Moon',
					description:
						'Today’s sunrise + sunset (from your weather location) and the current moon phase with illumination.',
					defaultSize: { w: 210, h: 64 },
					defaultConfig: { showSun: true, showMoon: true },
					configFields: [
						{
							key: 'showSun',
							label: 'sunrise / sunset',
							kind: 'toggle',
							group: 'Appearance',
							help: 'show today’s sunrise + sunset times (location is set in Plugins → Weather)'
						},
						{
							key: 'showMoon',
							label: 'moon phase',
							kind: 'toggle',
							group: 'Appearance',
							help: 'show the current moon phase + illumination'
						},
						{
							key: 'color',
							label: 'accent',
							kind: 'color',
							group: 'Appearance',
							help: 'sun / moon icon colour (blank = theme accent)'
						}
					]
				},
				component: asMeter(SunMoon)
			},
			{
				// Air Quality: European AQI + PM2.5 (separate Open-Meteo air-quality endpoint) and the UV
				// index (from the forecast current). binds:'none', multi-sensor.
				meta: {
					type: 'airquality',
					binds: 'none',
					sensors: () => ({ aqi: 'weather.air.aqi', pm25: 'weather.air.pm25', uv: 'weather.uv' }),
					label: 'Air Quality',
					description:
						'European Air Quality Index with a colour-coded band, plus PM2.5 and the UV index — for your weather location.',
					defaultSize: { w: 190, h: 86 },
					defaultConfig: { showPm: true, showUv: true },
					configFields: [
						{
							key: 'showPm',
							label: 'PM2.5',
							kind: 'toggle',
							group: 'Appearance',
							help: 'show the PM2.5 reading (location is set in Plugins → Weather)'
						},
						{
							key: 'showUv',
							label: 'UV index',
							kind: 'toggle',
							group: 'Appearance',
							help: 'show the UV index'
						},
						{
							key: 'color',
							label: 'accent',
							kind: 'color',
							group: 'Appearance',
							help: 'AQI band colour override (blank = colour-coded by band)'
						}
					]
				},
				component: asMeter(AirQuality)
			}
		]
	});
