import { describe, expect, it } from 'vitest';
import { appendEntry, listEntries, moveEntry, normalizeList, removeAt } from './sourceList';

describe('listEntries', () => {
	it('trims and drops blank lines, keeping order + case', () => {
		expect(listEntries('  Spotify \n\n foobar2000.exe \n')).toEqual(['Spotify', 'foobar2000.exe']);
	});
});

describe('appendEntry', () => {
	it('appends a trimmed, lowercased entry', () => {
		expect(appendEntry('a', '  FooBar2000  ')).toBe('a\nfoobar2000');
	});
	it('is a no-op for a duplicate (case-insensitive) or blank value', () => {
		expect(appendEntry('foobar2000', 'FOOBAR2000')).toBe('foobar2000');
		expect(appendEntry('a', '   ')).toBe('a');
	});
});

describe('removeAt', () => {
	it('removes the entry at the index', () => {
		expect(removeAt('a\nb\nc', 1)).toBe('a\nc');
	});
	it('is a no-op when out of range', () => {
		expect(removeAt('a\nb', 5)).toBe('a\nb');
		expect(removeAt('a\nb', -1)).toBe('a\nb');
	});
});

describe('moveEntry', () => {
	it('reorders an entry (up and down)', () => {
		expect(moveEntry('a\nb\nc', 2, 0)).toBe('c\na\nb');
		expect(moveEntry('a\nb\nc', 0, 1)).toBe('b\na\nc');
	});
	it('clamps the destination and no-ops on same index', () => {
		expect(moveEntry('a\nb\nc', 0, 99)).toBe('b\nc\na');
		expect(moveEntry('a\nb\nc', 1, 1)).toBe('a\nb\nc');
	});
	it('is a no-op when `from` is out of range', () => {
		expect(moveEntry('a\nb\nc', 5, 0)).toBe('a\nb\nc');
		expect(moveEntry('a\nb\nc', -1, 0)).toBe('a\nb\nc');
	});
});

describe('normalizeList', () => {
	it('lowercases, trims, and drops blanks + duplicates', () => {
		expect(normalizeList(' Spotify \n FOOBAR2000.exe \n\n spotify ')).toBe(
			'spotify\nfoobar2000.exe'
		);
	});
});
