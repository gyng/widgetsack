import { describe, it, expect } from 'vitest';
import { weatherInfo, forecastDayLabel, labelForecast } from './weather';

describe('weatherInfo', () => {
	it('maps representative WMO codes to a label', () => {
		expect(weatherInfo(0).label).toBe('Clear');
		expect(weatherInfo(3).label).toBe('Overcast');
		expect(weatherInfo(45).label).toBe('Fog');
		expect(weatherInfo(65).label).toBe('Rain');
		expect(weatherInfo(75).label).toBe('Snow');
		expect(weatherInfo(95).label).toBe('Thunderstorm');
	});

	it('swaps the clear / partly glyphs for night', () => {
		expect(weatherInfo(0, true).icon).toBe('☀️');
		expect(weatherInfo(0, false).icon).toBe('🌙');
		expect(weatherInfo(2, true).icon).toBe('⛅');
		expect(weatherInfo(2, false).icon).toBe('☁️');
	});

	it('falls back for an unknown code', () => {
		expect(weatherInfo(999)).toEqual({ label: '—', icon: '❓' });
	});
});

describe('forecastDayLabel', () => {
	// Mon 1 Jan 2024, noon local — a fixed base so the weekday math is deterministic across TZ.
	const base = new Date(2024, 0, 1, 12, 0, 0).getTime();

	it('labels today, then weekdays', () => {
		expect(forecastDayLabel(0, base)).toBe('Today');
		expect(forecastDayLabel(1, base)).toBe('Tue');
		expect(forecastDayLabel(2, base)).toBe('Wed');
		expect(forecastDayLabel(6, base)).toBe('Sun');
	});
});

describe('labelForecast', () => {
	const base = new Date(2024, 0, 1, 12, 0, 0).getTime();

	it('decorates each day with a label and a day-icon', () => {
		const days = labelForecast(
			[
				{ code: 0, high: 10, low: 2 },
				{ code: 61, high: 8, low: 4 },
				{ code: null, high: null, low: null }
			],
			base
		);
		expect(days[0]).toMatchObject({ label: 'Today', high: 10, info: { icon: '☀️' } });
		expect(days[1]).toMatchObject({ label: 'Tue', info: { label: 'Rain' } });
		// A missing code → neutral placeholder (still labeled).
		expect(days[2]).toMatchObject({ label: 'Wed', info: { icon: '❓' } });
	});
});
