import { describe, it, expect } from 'vitest';
import { weatherInfo, forecastDayLabel, labelForecast, type WeatherInfo } from './weather';

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

	it('maps every WMO 4677 code group to its label + day icon', () => {
		// One representative per case arm (covers the fall-through groups too).
		const expected: Record<number, WeatherInfo> = {
			0: { label: 'Clear', icon: '☀️' },
			1: { label: 'Mainly clear', icon: '🌤️' },
			2: { label: 'Partly cloudy', icon: '⛅' },
			3: { label: 'Overcast', icon: '☁️' },
			45: { label: 'Fog', icon: '🌫️' },
			48: { label: 'Fog', icon: '🌫️' },
			51: { label: 'Drizzle', icon: '🌦️' },
			53: { label: 'Drizzle', icon: '🌦️' },
			55: { label: 'Drizzle', icon: '🌦️' },
			56: { label: 'Freezing drizzle', icon: '🌧️' },
			57: { label: 'Freezing drizzle', icon: '🌧️' },
			61: { label: 'Rain', icon: '🌧️' },
			63: { label: 'Rain', icon: '🌧️' },
			65: { label: 'Rain', icon: '🌧️' },
			66: { label: 'Freezing rain', icon: '🌧️' },
			67: { label: 'Freezing rain', icon: '🌧️' },
			71: { label: 'Snow', icon: '🌨️' },
			73: { label: 'Snow', icon: '🌨️' },
			75: { label: 'Snow', icon: '🌨️' },
			77: { label: 'Snow grains', icon: '🌨️' },
			80: { label: 'Rain showers', icon: '🌦️' },
			81: { label: 'Rain showers', icon: '🌦️' },
			82: { label: 'Rain showers', icon: '🌦️' },
			85: { label: 'Snow showers', icon: '🌨️' },
			86: { label: 'Snow showers', icon: '🌨️' },
			95: { label: 'Thunderstorm', icon: '⛈️' },
			96: { label: 'Thunderstorm + hail', icon: '⛈️' },
			99: { label: 'Thunderstorm + hail', icon: '⛈️' }
		};
		for (const [code, info] of Object.entries(expected)) {
			expect(weatherInfo(Number(code)), code).toEqual(info);
		}
	});

	it('uses the night cloud glyph for partly-cloudy at night (code 2)', () => {
		expect(weatherInfo(2, false)).toEqual({ label: 'Partly cloudy', icon: '☁️' });
		expect(weatherInfo(1, false).icon).toBe('🌙');
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
