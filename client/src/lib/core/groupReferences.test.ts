import { describe, expect, it } from 'vitest';
import {
	definitionReaches,
	safeGroupReferences,
	withoutUnsafeDefinitions
} from './groupReferences';
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

describe('reference check cost and recovery', () => {
	// Each definition holds two instances of the next: 2^levels expansions without memoization.
	const fanOut = (levels: number, params?: Record<string, unknown>) => ({
		version: 1,
		defs: Array.from({ length: levels }, (_, i) => ({
			id: String(i),
			name: String(i),
			size,
			child: container(`row-${i}`, 'row', [
				leaf(group(`a-${i}`, size, clock, { def: String(i + 1), params })),
				leaf(group(`b-${i}`, size, clock, { def: String(i + 1), params }))
			])
		}))
	});
	it('checks repeated references once instead of expanding every path', () => {
		const started = performance.now();
		expect(validLibrary(fanOut(25))).toBe(true);
		expect(performance.now() - started).toBeLessThan(1000);
	});
	it('gives up on parameterized fan-out instead of freezing the studio', () => {
		const started = performance.now();
		expect(validLibrary(fanOut(25, { label: 'x' }))).toBe(false);
		expect(performance.now() - started).toBeLessThan(2000);
	});
	it('still applies the depth limit to a reused definition', () => {
		const deep = Array.from({ length: 66 }, (_, i) => def(String(i), String(i + 1)));
		const tree = container('row', 'row', [
			reference('33'),
			container('c', 'col', [reference('0')])
		]);
		expect(safeGroupReferences(tree, { version: 1, defs: deep })).toBe(false);
	});
	it('finds direct and indirect self-references for the definition being designed', () => {
		const library: Library = {
			version: 1,
			defs: [
				def('a', 'b'),
				{ ...def('b', 'missing'), child: container('c', 'col', [reference('c')]) },
				def('c', 'missing')
			]
		};
		expect(definitionReaches(library, 'a', 'a')).toBe(true);
		expect(definitionReaches(library, 'a', 'c')).toBe(true);
		expect(definitionReaches(library, 'c', 'a')).toBe(false);
		const diamond: Library = {
			version: 1,
			defs: [
				{
					...def('top', 'missing'),
					child: container('row', 'row', [
						reference('mid'),
						reference('mid'),
						leaf(group('inline', size, clock))
					])
				},
				def('mid', 'missing')
			]
		};
		expect(definitionReaches(diamond, 'top', 'elsewhere')).toBe(false);
		expect(definitionReaches(undefined, 'a', 'b')).toBe(false);
	});
	it('drops only unsafe definitions, limited to the candidates', () => {
		const library: Library = {
			version: 1,
			defs: [def('a', 'b'), def('b', 'a'), def('ok', 'a')]
		};
		const all = withoutUnsafeDefinitions(library);
		expect(all.dropped.sort()).toEqual(['a', 'b', 'ok']);
		const incoming = withoutUnsafeDefinitions(library, new Set(['b']));
		expect(incoming.dropped).toEqual(['b']);
		expect(incoming.library.defs.map((d) => d.id)).toEqual(['a', 'ok']);
		expect(validLibrary(incoming.library)).toBe(true);
		const clean: Library = { version: 1, defs: [def('ok', 'missing')] };
		expect(withoutUnsafeDefinitions(clean)).toEqual({ library: clean, dropped: [] });
	});
});
