import { describe, expect, it } from 'vitest';
import { unusedFileName } from './fileNames';

describe('unusedFileName', () => {
	it('keeps an available import name and skips case-insensitive collisions', () => {
		expect(unusedFileName('Nord', [], '-imported')).toBe('Nord');
		expect(unusedFileName('Nord', ['nord', 'NORD-imported', 'Nord-imported2'], '-imported')).toBe(
			'Nord-imported3'
		);
	});
	it('always gives duplicates a suffix and keeps long names within the file limit', () => {
		expect(unusedFileName('Nord', [], '-copy', true)).toBe('Nord-copy');
		const name = 'a'.repeat(64);
		const first = unusedFileName(name, [name], '-imported');
		const second = unusedFileName(name, [name, first], '-imported');
		expect(first).toHaveLength(64);
		expect(second).toHaveLength(64);
		expect(second).toMatch(/-imported2$/);
	});
});
