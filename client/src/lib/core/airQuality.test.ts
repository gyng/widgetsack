import { describe, it, expect } from 'vitest';
import { aqiBand, uvBand } from './airQuality';

describe('aqiBand', () => {
	it('buckets the European AQI into labelled bands', () => {
		expect(aqiBand(null).label).toBe('—');
		expect(aqiBand(10)).toEqual({ label: 'Good', level: 'good' });
		expect(aqiBand(30)).toEqual({ label: 'Fair', level: 'fair' });
		expect(aqiBand(50)).toEqual({ label: 'Moderate', level: 'moderate' });
		expect(aqiBand(70)).toEqual({ label: 'Poor', level: 'poor' });
		expect(aqiBand(90)).toEqual({ label: 'Very poor', level: 'verypoor' });
		expect(aqiBand(120)).toEqual({ label: 'Extremely poor', level: 'extreme' });
	});
});

describe('uvBand', () => {
	it('buckets the UV index into WHO bands', () => {
		expect(uvBand(null).label).toBe('—');
		expect(uvBand(1)).toEqual({ label: 'Low', level: 'low' });
		expect(uvBand(4)).toEqual({ label: 'Moderate', level: 'moderate' });
		expect(uvBand(6.4)).toEqual({ label: 'High', level: 'high' });
		expect(uvBand(9)).toEqual({ label: 'Very high', level: 'veryhigh' });
		expect(uvBand(12)).toEqual({ label: 'Extreme', level: 'extreme' });
	});
});
