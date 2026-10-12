import { describe, it, expect } from 'vitest';
import { volumePercent, volumeIcon } from './volume';

describe('volumePercent', () => {
	it('scales + clamps 0..1 to a 0..100 percent', () => {
		expect(volumePercent(null)).toBe(0);
		expect(volumePercent(0)).toBe(0);
		expect(volumePercent(0.5)).toBe(50);
		expect(volumePercent(1)).toBe(100);
		expect(volumePercent(1.5)).toBe(100);
	});
});

describe('volumeIcon', () => {
	it('reflects mute then level buckets', () => {
		expect(volumeIcon(0.8, true)).toBe('mute');
		expect(volumeIcon(0, false)).toBe('mute');
		expect(volumeIcon(0.2, false)).toBe('speaker-low');
		expect(volumeIcon(0.5, false)).toBe('speaker');
		expect(volumeIcon(0.9, false)).toBe('speaker-high');
		expect(volumeIcon(null, false)).toBe('mute');
	});
});
