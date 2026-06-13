import { describe, it, expect } from 'vitest';
import { binLevel } from './recyclebin';

describe('binLevel', () => {
	const GB = 1e9;

	it('is empty with no items', () => {
		expect(binLevel(0, 0, GB)).toBe('empty');
		expect(binLevel(null, 1234, GB)).toBe('empty');
	});

	it('is has when below the warn threshold', () => {
		expect(binLevel(5, 100 * 1e6, GB)).toBe('has');
	});

	it('is full at/above the warn threshold', () => {
		expect(binLevel(5, GB, GB)).toBe('full');
		expect(binLevel(5, 2 * GB, GB)).toBe('full');
	});

	it('never flags full when the threshold is disabled (0)', () => {
		expect(binLevel(5, 99 * GB, 0)).toBe('has');
	});
});
