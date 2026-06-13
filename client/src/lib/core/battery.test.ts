import { describe, it, expect } from 'vitest';
import { batteryStatusText, batteryLevel } from './battery';

describe('batteryStatusText', () => {
	it('labels charging / ac', () => {
		expect(batteryStatusText('charging', null)).toBe('Charging');
		expect(batteryStatusText('ac', 5000)).toBe('Plugged in');
	});
	it('shows time-left when discharging with a known time, else "On battery"', () => {
		expect(batteryStatusText('discharging', 8100)).toBe('2h 15m left');
		expect(batteryStatusText('discharging', 0)).toBe('On battery');
		expect(batteryStatusText('discharging', null)).toBe('On battery');
	});
	it('is blank for unknown / missing state', () => {
		expect(batteryStatusText('unknown', null)).toBe('');
		expect(batteryStatusText(null, null)).toBe('');
	});
});

describe('batteryLevel', () => {
	it('buckets by charge — but charging (and unknown) are always ok', () => {
		expect(batteryLevel(50, false)).toBe('ok');
		expect(batteryLevel(18, false)).toBe('low');
		expect(batteryLevel(7, false)).toBe('critical');
		expect(batteryLevel(5, true)).toBe('ok'); // charging
		expect(batteryLevel(null, false)).toBe('ok');
	});
});
