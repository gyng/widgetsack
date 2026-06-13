import { describe, it, expect } from 'vitest';
import { parseRssList } from './rss';

describe('parseRssList', () => {
	it('parses well-formed items', () => {
		expect(
			parseRssList([
				{ title: 'Headline one', link: 'https://ex.com/1' },
				{ title: 'Headline two', link: 'https://ex.com/2' }
			])
		).toEqual([
			{ title: 'Headline one', link: 'https://ex.com/1' },
			{ title: 'Headline two', link: 'https://ex.com/2' }
		]);
	});

	it('drops malformed entries and defaults a missing link', () => {
		expect(parseRssList(null)).toEqual([]);
		expect(parseRssList('nope')).toEqual([]);
		expect(parseRssList([{ link: 'x' }, 5, null, { title: 'ok' }])).toEqual([
			{ title: 'ok', link: '' }
		]);
	});
});
