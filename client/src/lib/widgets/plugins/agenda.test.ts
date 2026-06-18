import { describe, expect, it } from 'vitest';
import { registerAgendaPlugin } from './agenda';
import { getMeta } from '../../core/widget';

registerAgendaPlugin();

describe('agenda plugin', () => {
	it('registers the agenda widget with title / maxRows / color config', () => {
		const meta = getMeta('agenda');
		expect(meta).toBeTruthy();
		const keys = (meta?.configFields ?? []).map((f) => f.key);
		expect(keys).toEqual(expect.arrayContaining(['title', 'maxRows', 'color']));
	});
});
