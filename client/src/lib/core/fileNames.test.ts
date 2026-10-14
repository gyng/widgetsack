import { describe, expect, it } from 'vitest';
import { safeFileStem, unusedFileName } from './fileNames';

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

describe('safeFileStem', () => {
	it.each([
		['Nord', 'Nord'],
		['Rosé', 'Rose'],
		['a.b', 'a-b'],
		['../evil', 'evil'],
		['  spaced  ', 'spaced'],
		['日本', 'theme'],
		['', 'theme'],
		['CON', 'CON-theme'],
		['com1', 'com1-theme']
	])('%j → %j (a name the backend valid_name accepts)', (input, expected) => {
		expect(safeFileStem(input, 'theme')).toBe(expected);
	});
	it('keeps the result within the 64-character limit with no trailing space', () => {
		const out = safeFileStem(`${'a'.repeat(63)} b`, 'theme');
		expect(out).toBe('a'.repeat(63));
	});
});
