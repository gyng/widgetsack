import { describe, it, expect } from 'vitest';
import { weatherInfo } from './weather';

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
