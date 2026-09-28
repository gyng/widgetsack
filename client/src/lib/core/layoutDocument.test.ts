import { describe, expect, it } from 'vitest';
import { decodeLayoutDocument } from './layoutDocument';
import { emptyMonitorLayout } from './layoutTree';

describe('layout document decoding', () => {
	it('distinguishes a missing file from invalid JSON and unsupported document shapes', () => {
		expect(decodeLayoutDocument(null).kind).toBe('missing');
		for (const raw of ['', '{bad', 'null', '[]', '{"version":99,"monitors":{}}', '{"version":2}']) {
			expect(decodeLayoutDocument(raw).kind, raw).toBe('corrupt');
		}
	});
	it('normalizes omitted globals and filters malformed token values', () => {
		const result = decodeLayoutDocument(
			JSON.stringify({ version: 2, monitors: {}, tokens: { good: 'red', bad: 42 } })
		);
		expect(result).toMatchObject({
			kind: 'valid',
			theme: '',
			themeLock: true,
			tokens: { good: 'red' },
			library: undefined,
			droppedMonitors: []
		});
	});
	it('reports damaged monitor entries while retaining valid monitors and raw extension fields', () => {
		const result = decodeLayoutDocument(
			JSON.stringify({
				version: 2,
				monitors: { good: emptyMonitorLayout(), bad: { root: { kind: 'invalid' } } },
				extension: 1
			})
		);
		expect(result).toMatchObject({
			kind: 'valid',
			droppedMonitors: ['bad'],
			raw: { extension: 1 }
		});
		if (result.kind === 'valid') expect(Object.keys(result.layout.monitors)).toEqual(['good']);
	});
	it('migrates a legacy document through the existing layout grammar', () => {
		const result = decodeLayoutDocument(
			JSON.stringify({ version: 1, monitors: { a: { widgets: [] } } })
		);
		expect(result).toMatchObject({
			kind: 'valid',
			layout: { version: 2, monitors: { a: { floating: [] } } }
		});
	});
});
