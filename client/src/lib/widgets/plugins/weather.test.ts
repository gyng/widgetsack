import { describe, expect, it } from 'vitest';
import { registerWeatherPlugin } from './weather';
import { getMeta } from '../../core/widget';
import { listSources } from '../../core/plugin';

registerWeatherPlugin();

describe('weather plugin', () => {
	it('registers the weather, sunmoon and airquality widgets', () => {
		for (const t of ['weather', 'sunmoon', 'airquality']) {
			expect(getMeta(t), t).toBeTruthy();
		}
	});

	it('exposes display toggles on the weather + sunmoon widgets', () => {
		const keys = (t: string): string[] => (getMeta(t)?.configFields ?? []).map((f) => f.key);
		expect(keys('weather')).toContain('showHiLo');
		expect(keys('sunmoon')).toEqual(expect.arrayContaining(['showSun', 'showMoon']));
	});

	it('registers a sensor source', () => {
		expect(listSources().some((s) => s.id === 'weather')).toBe(true);
	});

	it('the sunmoon sensors resolver binds sunrise + sunset', () => {
		const sensors = getMeta('sunmoon')?.sensors as () => Record<string, string>;
		expect(typeof sensors).toBe('function');
		expect(sensors()).toEqual({ rise: 'weather.sun.rise', set: 'weather.sun.set' });
	});

	it('the airquality sensors resolver binds aqi/pm25/uv', () => {
		const sensors = getMeta('airquality')?.sensors as () => Record<string, string>;
		expect(typeof sensors).toBe('function');
		expect(sensors()).toEqual({
			aqi: 'weather.air.aqi',
			pm25: 'weather.air.pm25',
			uv: 'weather.uv'
		});
	});

	it('the weather sensors resolver expands forecast-day series, clamped to 0..7', () => {
		const sensors = getMeta('weather')?.sensors as (
			c: Record<string, unknown>
		) => Record<string, string>;
		expect(typeof sensors).toBe('function');
		const map = sensors({ forecastDays: 2 });
		expect(map.temp).toBe('weather.temp');
		expect(map.d0high).toBe('weather.day.0.high');
		expect(map.d1code).toBe('weather.day.1.code');
		expect(map.d2high).toBeUndefined(); // only days 0..1 for forecastDays:2
		// out-of-range clamps to 7 days (× high/low/code)
		const dayKeys = Object.keys(sensors({ forecastDays: 99 })).filter((k) => /^d\d/.test(k));
		expect(dayKeys).toHaveLength(7 * 3);
		// no forecastDays → base map only
		expect(Object.keys(sensors({}))).toContain('temp');
	});
});
