import { describe, it, expect } from 'vitest';
import { signalBars, wifiLevel } from './wifi';

describe('signalBars', () => {
	it('buckets 0–100 quality into 0..4 bars', () => {
		expect(signalBars(null)).toBe(0);
		expect(signalBars(0)).toBe(0);
		expect(signalBars(20)).toBe(1);
		expect(signalBars(45)).toBe(2);
		expect(signalBars(65)).toBe(3);
		expect(signalBars(90)).toBe(4);
	});
});

describe('wifiLevel', () => {
	it('labels by bar count', () => {
		expect(wifiLevel(null)).toBe('none');
		expect(wifiLevel(20)).toBe('weak');
		expect(wifiLevel(45)).toBe('ok');
		expect(wifiLevel(65)).toBe('good');
		expect(wifiLevel(90)).toBe('strong');
	});
});
