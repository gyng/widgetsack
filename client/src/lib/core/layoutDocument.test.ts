import { describe, expect, it } from 'vitest';
import { decodeLayoutDocument } from './layoutDocument';
import { container, emptyMonitorLayout, group, leaf } from './layoutTree';

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
			droppedMonitors: [],
			droppedDefinitions: []
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
	it('classifies a damaged reusable library as corrupt instead of rendering it', () => {
		expect(
			decodeLayoutDocument(
				JSON.stringify({ version: 2, monitors: {}, library: { version: 1, defs: [null] } })
			).kind
		).toBe('corrupt');
	});
	it('drops a self-containing definition instead of discarding every monitor', () => {
		const clock = leaf({ id: 'c', type: 'clock', rect: { x: 0, y: 0, w: 10, h: 10 }, config: {} });
		const size = { w: 10, h: 10 };
		const self = {
			id: 'self',
			name: 'Self',
			size,
			child: leaf(group('g', size, clock, { def: 'self' }))
		};
		const kept = { id: 'kept', name: 'Kept', size, child: clock };
		const monitor = { root: container('root', 'col', [clock]), floating: [] };
		const result = decodeLayoutDocument(
			JSON.stringify({
				version: 2,
				monitors: { main: monitor },
				library: { version: 1, defs: [self, kept] }
			})
		);
		expect(result).toMatchObject({
			kind: 'valid',
			droppedDefinitions: ['self'],
			library: { defs: [kept] }
		});
		if (result.kind === 'valid') expect(result.layout.monitors.main).toEqual(monitor);
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
