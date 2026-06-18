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
});
