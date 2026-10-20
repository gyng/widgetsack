import { expect, it } from 'vitest';
import { readUsageSettings, resolveUsageSettings, usageResetText } from './aiUsageSettings';
it('validates row settings and preserves legacy defaults beneath row overrides', () => {
	expect(readUsageSettings(null)).toEqual({});
	expect(readUsageSettings('bad')).toEqual({});
	const value = {
		remaining: false,
		showResets: true,
		resetDisplay: 'date',
		warning: 0,
		critical: 100,
		graphHours: 720,
		graphMetric: 'quota',
		rateHours: 0.25
	} as const;
	expect(readUsageSettings(value)).toEqual(value);
	expect(
		readUsageSettings({ ...value, resetDisplay: 'both', graphMetric: 'credits' })
	).toMatchObject({ resetDisplay: 'both', graphMetric: 'credits' });
	expect(
		readUsageSettings({ ...value, resetDisplay: 'countdown', graphMetric: 'tokens' })
	).toMatchObject({ resetDisplay: 'countdown', graphMetric: 'tokens' });
	for (const invalid of ['bad', NaN, -1, 10000])
		expect(
			readUsageSettings({
				remaining: 'bad',
				showResets: 1,
				resetDisplay: 'bad',
				graphMetric: 'bad',
				warning: invalid,
				critical: invalid,
				graphHours: invalid,
				rateHours: invalid
			})
		).toEqual({});
	expect(
		resolveUsageSettings({ remaining: true }, { remaining: false, showResets: true })
	).toMatchObject({ remaining: true, showResets: true });
	expect(resolveUsageSettings({}).remaining).toBe(true);
});
it('formats reset boundaries as minutes, hours, days and weeks', () => {
	for (const [minutes, text] of [
		[-1, 'due'],
		[0, 'due'],
		[0.1, '1m'],
		[5, '5m'],
		[59, '59m'],
		[60, '1h'],
		[780, '13h'],
		[1440, '1d'],
		[6 * 1440, '6d'],
		[10080, '1w'],
		[3 * 10080, '3w']
	] as const)
		expect(usageResetText(minutes * 60000, 0)).toBe(text);
});
