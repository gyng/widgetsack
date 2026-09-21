import { describe, expect, it } from 'vitest';
import {
	isSack,
	mergeLibrary,
	packSack,
	sackConsentMessage,
	sanitizeSack,
	unpackSack
} from './sack';
import type { Leaf, Library, WidgetDef } from './layoutTree';

const widgetLeaf = (id: string): Leaf => ({
	id,
	unit: { id, type: 'text', rect: { x: 0, y: 0, w: 1, h: 1 }, config: {} }
});

const groupLeaf = (id: string, def: string): Leaf => ({
	id,
	unit: { id, kind: 'group', def, size: { w: 1, h: 1 }, child: widgetLeaf(`${id}-c`) }
});

// A group leaf with no `def` (an inline group whose child is used directly).
const inlineGroupLeaf = (id: string): Leaf => ({
	id,
	unit: { id, kind: 'group', size: { w: 1, h: 1 }, child: widgetLeaf(`${id}-c`) }
});

const mkDef = (id: string, child: Leaf = widgetLeaf(`${id}-c`)): WidgetDef => ({
	id,
	name: id.toUpperCase(),
	size: { w: 10, h: 10 },
	child
});

describe('sack pack/unpack', () => {
	it('round-trips a library + theme through pack -> JSON -> unpack', () => {
		const library: Library = { version: 1, defs: [mkDef('a')] };
		const sack = packSack({ library, theme: { name: 't', css: ':root{}' }, name: 'mine' });
		const round = unpackSack(JSON.stringify(sack));
		expect(round).toEqual(sack);
		expect(round?.library?.defs[0].id).toBe('a');
		expect(round?.theme?.name).toBe('t');
	});

	it('omits empty parts when packing', () => {
		expect(packSack({ library: { version: 1, defs: [] } })).toEqual({
			kind: 'widgetsack/sack',
			version: 1
		});
	});

	it('omits an empty tokens object but includes a non-empty one', () => {
		expect(packSack({ tokens: {} })).toEqual({ kind: 'widgetsack/sack', version: 1 });
		expect(packSack({ tokens: { '--np-accent': 'red' } })).toEqual({
			kind: 'widgetsack/sack',
			version: 1,
			tokens: { '--np-accent': 'red' }
		});
	});

	it('isSack rejects a raw widgets.json (no kind tag), and unpack rejects malformed input', () => {
		expect(isSack({ version: 2, monitors: {} })).toBe(false);
		expect(unpackSack('{"version":2,"monitors":{}}')).toBeNull();
		expect(unpackSack('not json')).toBeNull();
	});
});

describe('mergeLibrary', () => {
	it('appends non-colliding defs unchanged', () => {
		const into: Library = { version: 1, defs: [mkDef('a')] };
		const { library, idMap } = mergeLibrary(into, [mkDef('b')]);
		expect(library.defs.map((d) => d.id)).toEqual(['a', 'b']);
		expect(idMap).toEqual({ b: 'b' });
	});

	it('regenerates a colliding def id', () => {
		const into: Library = { version: 1, defs: [mkDef('a')] };
		const { library, idMap } = mergeLibrary(into, [mkDef('a')]);
		expect(idMap.a).toBe('a-2');
		expect(library.defs.map((d) => d.id)).toEqual(['a', 'a-2']);
	});

	it('rewrites nested group.def cross-references when both defs are remapped', () => {
		const into: Library = { version: 1, defs: [mkDef('a'), mkDef('b')] };
		const incomingA = mkDef('a', groupLeaf('g', 'b')); // A references B via a nested group
		const incomingB = mkDef('b');
		const { library, idMap } = mergeLibrary(into, [incomingA, incomingB]);
		expect(idMap).toEqual({ a: 'a-2', b: 'b-2' });
		const mergedA = library.defs.find((d) => d.id === 'a-2');
		const grp = (mergedA!.child as Leaf).unit as { def: string };
		expect(grp.def).toBe('b-2'); // points to B's NEW id
	});

	it('rewrites group refs nested inside a CONTAINER child (recursion)', () => {
		const into: Library = { version: 1, defs: [mkDef('a'), mkDef('b')] };
		// A's child is a container whose descendant is a group referencing B — exercises the
		// container-recursion branch of remapRefs (not just a top-level group leaf).
		const incomingA: WidgetDef = {
			id: 'a',
			name: 'A',
			size: { w: 10, h: 10 },
			child: { id: 'row', kind: 'row', children: [groupLeaf('g', 'b')] }
		};
		const { library, idMap } = mergeLibrary(into, [incomingA, mkDef('b')]);
		const mergedA = library.defs.find((d) => d.id === idMap.a);
		const cont = mergedA?.child as { children: Leaf[] };
		const grp = cont.children[0].unit as { def: string };
		expect(grp.def).toBe(idMap.b);
	});

	it('does not mutate the incoming defs', () => {
		const incoming = mkDef('a', groupLeaf('g', 'a'));
		const into: Library = { version: 1, defs: [mkDef('a')] };
		mergeLibrary(into, [incoming]);
		expect(incoming.id).toBe('a');
		expect(((incoming.child as Leaf).unit as { def: string }).def).toBe('a');
	});

	it('leaves an inline group (no def) untouched — remapRefs just recurses into its child', () => {
		const into: Library = { version: 1, defs: [mkDef('a')] };
		const incomingA = mkDef('a', inlineGroupLeaf('g'));
		const { library, idMap } = mergeLibrary(into, [incomingA]);
		const mergedA = library.defs.find((d) => d.id === idMap.a);
		const grp = (mergedA!.child as Leaf).unit as { def?: string };
		expect(grp.def).toBeUndefined();
	});

	it('leaves a group.def unchanged when it references a def outside the incoming batch', () => {
		// 'x' is already in the library and isn't part of this merge, so it never lands in idMap —
		// the reference must be left exactly as-is (not blanked or rewritten).
		const into: Library = { version: 1, defs: [mkDef('a'), mkDef('x')] };
		const incomingB = mkDef('b', groupLeaf('g', 'x'));
		const { library, idMap } = mergeLibrary(into, [incomingB]);
		const mergedB = library.defs.find((d) => d.id === idMap.b);
		const grp = (mergedB!.child as Leaf).unit as { def: string };
		expect(grp.def).toBe('x');
	});

	it('merges into an undefined library (fresh library, version defaults to 1)', () => {
		const { library, idMap } = mergeLibrary(undefined, [mkDef('a')]);
		expect(library).toEqual({ version: 1, defs: [mkDef('a')] });
		expect(idMap).toEqual({ a: 'a' });
	});

	it('resolves a chain of collisions (base and base-2 both taken) by skipping past both', () => {
		const into: Library = { version: 1, defs: [mkDef('a'), mkDef('a-2')] };
		const { library, idMap } = mergeLibrary(into, [mkDef('a')]);
		expect(idMap.a).toBe('a-3');
		expect(library.defs.map((d) => d.id)).toEqual(['a', 'a-2', 'a-3']);
	});
});

describe('mergeLibrary param hardening', () => {
	it('drops prototype-walking param specs from incoming defs (defence in depth with setPath)', () => {
		const def: WidgetDef = {
			...mkDef('p'),
			params: [
				{ key: 'ok', target: 'unit.config.ok' },
				{ key: 'evil', target: 'unit.__proto__.polluted' }
			]
		};
		const { library } = mergeLibrary(undefined, [def]);
		expect(library.defs[0].params).toEqual([{ key: 'ok', target: 'unit.config.ok' }]);
		// a def without params stays without params (shape preserved); a malformed (non-array) params
		// becomes an empty list rather than reaching the solver
		expect('params' in mergeLibrary(undefined, [mkDef('q')]).library.defs[0]).toBe(false);
		const junk = { ...mkDef('j'), params: 'nope' as unknown as WidgetDef['params'] };
		expect(mergeLibrary(undefined, [junk]).library.defs[0].params).toEqual([]);
	});
});

const iframeLeaf = (id: string, config: Record<string, unknown>): Leaf => ({
	id,
	unit: { id, type: 'iframe', rect: { x: 0, y: 0, w: 1, h: 1 }, config }
});

describe('sackConsentMessage', () => {
	it('is empty for a clean sack (no theme threats, no capability-bearing widgets)', () => {
		expect(sackConsentMessage({ kind: 'widgetsack/sack', version: 1 })).toBe('');
		expect(
			sackConsentMessage({
				kind: 'widgetsack/sack',
				version: 1,
				theme: { name: 't', css: ':root { --np-accent: gold }' },
				library: { version: 1, defs: [mkDef('a')] }
			})
		).toBe('');
	});

	it('aggregates theme CSS threats and widget-tree threats into one paragraph', () => {
		const msg = sackConsentMessage({
			kind: 'widgetsack/sack',
			version: 1,
			theme: { name: 't', css: '@import url(https://evil.example/x.css);' },
			library: {
				version: 1,
				defs: [
					mkDef('f', iframeLeaf('fr', { url: 'https://dash.example', sandbox: false })),
					{ ...mkDef('c'), css: '.x { position: fixed }' }
				]
			}
		});
		expect(msg).toBe(
			"This sack's theme contains 2 remote resources (could phone home).\n" +
				'Its widgets contain 1 embedded web page (unsandboxed), 1 CSS rule that reaches outside the app.\n' +
				'Imported theme and widget CSS runs with full access to the studio; embedded pages are ' +
				'forced into the sandbox. Import anyway?'
		);
	});

	it('warns about widgets alone (no theme) and tolerates a malformed library', () => {
		const msg = sackConsentMessage({
			kind: 'widgetsack/sack',
			version: 1,
			library: { version: 1, defs: [mkDef('f', iframeLeaf('fr', { url: 'https://a' }))] }
		});
		expect(msg.startsWith('Its widgets contain 1 embedded web page.')).toBe(true);
		expect(
			sackConsentMessage({
				kind: 'widgetsack/sack',
				version: 1,
				library: { version: 1, defs: 'nope' as unknown as WidgetDef[] }
			})
		).toBe('');
	});
});

describe('sanitizeSack', () => {
	it('forces the iframe sandbox on and drops unsafe param specs, counting changes; input untouched', () => {
		const sack = {
			kind: 'widgetsack/sack' as const,
			version: 1 as const,
			library: {
				version: 1,
				defs: [
					{
						...mkDef('f', iframeLeaf('fr', { url: 'https://a', sandbox: false })),
						params: [{ key: 'k', target: 'constructor.prototype.x' }]
					},
					mkDef('clean')
				]
			}
		};
		const before = JSON.stringify(sack);
		const r = sanitizeSack(sack);
		expect(r.changed).toBe(2);
		expect(JSON.stringify(sack)).toBe(before);
		const defs = r.sack.library!.defs;
		expect((defs[0].child as Leaf).unit).toMatchObject({ config: { sandbox: true } });
		expect(defs[0].params).toEqual([]);
		expect(defs[1]).toBe(sack.library.defs[1]); // untouched def keeps its identity
	});

	it('is a no-op for a sack without a library (or a malformed one)', () => {
		const bare = { kind: 'widgetsack/sack' as const, version: 1 as const };
		expect(sanitizeSack(bare)).toEqual({ sack: bare, changed: 0 });
		const bad = { ...bare, library: { version: 1, defs: 'x' as unknown as WidgetDef[] } };
		expect(sanitizeSack(bad).sack).toBe(bad);
	});
});
