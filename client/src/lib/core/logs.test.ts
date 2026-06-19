import { describe, expect, it } from 'vitest';
import { atLeastLevel, LOG_LEVELS, type LogLevel } from './logs';

describe('logs', () => {
	it('LOG_LEVELS is ascending severity', () => {
		expect(LOG_LEVELS).toEqual(['trace', 'debug', 'info', 'warn', 'error']);
	});

	it('atLeastLevel compares severity (inclusive)', () => {
		expect(atLeastLevel('warn', 'info')).toBe(true); // higher
		expect(atLeastLevel('info', 'info')).toBe(true); // equal
		expect(atLeastLevel('info', 'warn')).toBe(false); // lower
		expect(atLeastLevel('trace', 'error')).toBe(false); // extreme low vs high
		expect(atLeastLevel('error', 'trace')).toBe(true); // extreme high vs low
	});

	it('every level is at least itself', () => {
		for (const l of LOG_LEVELS) expect(atLeastLevel(l as LogLevel, l as LogLevel)).toBe(true);
	});
});
