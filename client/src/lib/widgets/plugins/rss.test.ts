import { describe, expect, it } from 'vitest';
import { registerRssPlugin } from './rss';
import { getMeta } from '../../core/widget';

registerRssPlugin();

describe('rss plugin', () => {
	it('registers the rss widget with title / maxRows / color config', () => {
		const meta = getMeta('rss');
		expect(meta).toBeTruthy();
		const keys = (meta?.configFields ?? []).map((f) => f.key);
		expect(keys).toEqual(expect.arrayContaining(['title', 'maxRows', 'color']));
	});
});
