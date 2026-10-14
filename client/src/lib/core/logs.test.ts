import { describe, expect, it } from 'vitest';
import { atLeastLevel, LOG_LEVELS, mergeLogBacklog, type LogLevel, type LogRecord } from './logs';

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

describe('mergeLogBacklog', () => {
	const rec = (message: string, ts_ms = 1): LogRecord => ({
		ts_ms,
		level: 'info',
		target: 't',
		message
	});

	it('keeps live records that arrived before the backlog but are missing from it', () => {
		// `late` was buffered after the backlog snapshot but streamed before the reply landed.
		expect(mergeLogBacklog([rec('a'), rec('b')], [rec('b'), rec('late', 2)])).toEqual([
			rec('a'),
			rec('b'),
			rec('late', 2)
		]);
	});

	it('dedupes only as many copies as the backlog holds (identical lines can repeat)', () => {
		expect(mergeLogBacklog([rec('x')], [rec('x'), rec('x')])).toEqual([rec('x'), rec('x')]);
		expect(
			mergeLogBacklog([{ ...rec('x'), fields: { a: '1' } }], [{ ...rec('x'), fields: { a: '2' } }])
		).toHaveLength(2);
	});
});
