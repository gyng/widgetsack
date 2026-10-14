import { describe, expect, it } from 'vitest';
import { safeGroupReferences } from './groupReferences';
import { validLibrary } from './libraryValidation';
import { collectRenderables, resolveGroup } from './solve';
import { container, group, leaf, type Library } from './layoutTree';
const size = { w: 100, h: 50 };
const clock = leaf({ id: 'clock', type: 'clock', rect: { x: 0, y: 0, ...size }, config: {} });
const reference = (id: string) => leaf(group(`ref-${id}`, size, clock, { def: id }));
const def = (id: string, next: string) => ({ id, name: id, size, child: reference(next) });

describe('definition reference safety', () => {
	it('accepts an inline tree without a library or an active reference path', () => {
		expect(safeGroupReferences(reference('missing'), undefined)).toBe(true);
	});
	it.each([
		{ version: 1, defs: [def('a', 'a')] },
		{ version: 1, defs: [def('a', 'b'), def('b', 'a')] }
	])('rejects cyclic libraries before import or reload', (library) => {
		expect(validLibrary(library)).toBe(false);
	});
	it('keeps an unvalidated cyclic library from reaching recursive rendering', () => {
		const library: Library = { version: 1, defs: [def('a', 'b'), def('b', 'a')] };
		const resolved = resolveGroup(group('instance', size, clock, { def: 'a' }), library);
		expect(resolved.child).toMatchObject({ kind: 'col', children: [] });
		expect(
			collectRenderables(
				{ root: container('root', 'col', [reference('a')]), floating: [] },
				new Map(),
				library
			)
		).toEqual([]);
	});
	it('allows repeated references and unresolved references with finite inline fallbacks', () => {
		expect(
			validLibrary({
				version: 1,
				defs: [
					{ ...def('a', 'b'), child: container('row', 'row', [reference('b'), reference('b')]) },
					def('b', 'missing')
				]
			})
		).toBe(true);
	});
	it('rejects trees whose expanded reference depth exceeds the safe limit', () => {
		const defs = Array.from({ length: 70 }, (_, i) => def(String(i), String(i + 1)));
		expect(validLibrary({ version: 1, defs })).toBe(false);
	});
	it('rejects parameter overrides that create a reference cycle', () => {
		const nested = group('nested', size, clock, { def: 'b', params: { next: 'a' } });
		const library: Library = {
			version: 1,
			defs: [
				{ id: 'a', name: 'A', size, child: leaf(nested) },
				{ ...def('b', 'missing'), params: [{ key: 'next', target: 'unit.def' }] }
			]
		};
		expect(validLibrary(library)).toBe(false);
		expect(resolveGroup(group('instance', size, clock, { def: 'a' }), library).child).toMatchObject(
			{ children: [] }
		);
	});
});
