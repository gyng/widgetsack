import { describe, expect, it } from 'vitest';
import type { WidgetInstance } from './layout';
import {
	container,
	group,
	leaf,
	type Container,
	type Library,
	type Leaf,
	type MonitorLayout
} from './layoutTree';
import {
	collectContainerRects,
	collectGridPlaceholders,
	collectRenderables,
	collectSplitters,
	gridCellRects,
	intrinsicSize,
	resizeSplit,
	resolveGroup,
	type Solved
} from './solve';

// A primitive sized w×h at the origin (only rect.{w,h} matter for in-flow intrinsics).
const prim = (
	id: string,
	w: number,
	h: number,
	extra: Partial<WidgetInstance> = {}
): WidgetInstance => ({
	id,
	type: 'gauge',
	rect: { x: 0, y: 0, w, h },
	config: {},
	...extra
});

// ---- intrinsicSize -------------------------------------------------------

describe('intrinsicSize', () => {
	it('a row of two 50×40 auto leaves is 100×40', () => {
		const c = container('r', 'row', [leaf(prim('A', 50, 40)), leaf(prim('B', 50, 40))]);
		expect(intrinsicSize(c)).toEqual({ w: 100, h: 40 });
	});

	it('a col of two leaves stacks height, takes max width', () => {
		const c = container('c', 'col', [leaf(prim('A', 50, 40)), leaf(prim('B', 80, 20))]);
		expect(intrinsicSize(c)).toEqual({ w: 80, h: 60 });
	});

	it('a bare primitive leaf reports its own rect', () => {
		expect(intrinsicSize(leaf(prim('A', 64, 24)))).toEqual({ w: 64, h: 24 });
	});

	it('an explicit `bounds` overrides the derived size on both axes', () => {
		const c = container('c', 'col', [leaf(prim('A', 50, 40))], {
			bounds: { x: 0, y: 0, w: 7, h: 9 }
		});
		expect(intrinsicSize(c)).toEqual({ w: 7, h: 9 });
	});

	it('an empty container collapses to just its padding', () => {
		const c = container('c', 'col', [], { pad: { t: 3, r: 5, b: 7, l: 11 } });
		// padAlong horizontal = l+r = 16, vertical = t+b = 10.
		expect(intrinsicSize(c)).toEqual({ w: 16, h: 10 });
	});

	it('an overlap container is only as big as its largest child (plus pad)', () => {
		const c = container('c', 'row', [leaf(prim('A', 50, 40)), leaf(prim('B', 80, 20))], {
			overlap: true,
			pad: 5
		});
		// max width 80 + 2*5, max height 40 + 2*5 — children share one box, not summed.
		expect(intrinsicSize(c)).toEqual({ w: 90, h: 50 });
	});

	it('a group leaf reports its resolved def size as its intrinsic box', () => {
		const lib: Library = {
			version: 1,
			defs: [{ id: 'cg', name: 'cg', size: { w: 40, h: 26 }, child: leaf(prim('spk', 1, 1)) }]
		};
		const g = leaf(group('g0', { w: 999, h: 999 }, leaf(prim('fb', 1, 1)), { def: 'cg' }));
		// resolveGroup picks the def's size (40×26), not the inline 999×999.
		expect(intrinsicSize(g, lib)).toEqual({ w: 40, h: 26 });
	});

	describe('grid intrinsic sizing', () => {
		it('a uniform grid is cols × max-child-width + gaps wide, rows × max-child-height + gaps tall', () => {
			// 2 cols, 2 children → 1 row. max child 30×20, gap 4.
			const g = container('g', 'grid', [leaf(prim('A', 30, 20)), leaf(prim('B', 10, 10))], {
				cols: 2,
				gap: 4
			});
			// w = 30*2 + 4*(2-1) = 64 ; h = 20*1 + 4*0 = 20.
			expect(intrinsicSize(g)).toEqual({ w: 64, h: 20 });
		});

		it('a bounds-less grid with no explicit cols defaults to a single track', () => {
			// no cols → cols defaults to 1; 3 children → 3 rows.
			const g = container('g', 'grid', [
				leaf(prim('A', 30, 20)),
				leaf(prim('B', 10, 10)),
				leaf(prim('C', 10, 10))
			]);
			// w = max-child-width 30 * 1 col ; h = max-child-height 20 * 3 rows.
			expect(intrinsicSize(g)).toEqual({ w: 30, h: 60 });
		});

		it('an explicit `rows` minimum grows the intrinsic height even with few children', () => {
			const g = container('g', 'grid', [leaf(prim('A', 30, 20))], { cols: 1, rows: 3, gap: 2 });
			// rows = max(3, ceil(1/1)) = 3 → h = 20*3 + 2*(3-1) = 64.
			expect(intrinsicSize(g).h).toBe(64);
		});

		it('a grid with per-cell fixed widths sums each track (fixed size, else its largest child)', () => {
			const c0 = container('c0', 'col', [leaf(prim('A', 5, 5))], { cellW: 100 });
			const g = container('g', 'grid', [c0, leaf(prim('B', 30, 10))], { cols: 2, gap: 6 });
			// track 0 fixed 100, track 1 = max child width 30 → w = 100 + 30 + 6*(2-1) = 136.
			expect(intrinsicSize(g).w).toBe(136);
		});

		it('a grid with per-cell fixed heights sums each row track', () => {
			const c0 = container('c0', 'col', [leaf(prim('A', 5, 5))], { cellH: 80 });
			const g = container('g', 'grid', [c0, leaf(prim('B', 10, 40))], { cols: 1 });
			// 1 col → 2 rows; row 0 fixed 80, row 1 = max child height 40 → h = 80 + 40 = 120.
			expect(intrinsicSize(g).h).toBe(120);
		});
	});
});

// ---- groups (resolveGroup only — the solver-driven cases are gone) -------

describe('groups', () => {
	it('resolveGroup: def overrides inline size + child', () => {
		const childC = leaf(prim('C', 1, 1));
		const lib: Library = {
			version: 1,
			defs: [{ id: 'core-graph', name: 'cg', size: { w: 40, h: 26 }, child: childC }]
		};
		const r = resolveGroup(
			group('inst', { w: 999, h: 999 }, leaf(prim('dummy', 1, 1)), { def: 'core-graph' }),
			lib
		);
		expect(r.size).toEqual({ w: 40, h: 26 });
		expect((r.child as Leaf).id).toBe('C');
	});

	it('resolveGroup: missing def falls back to inline child + size (no throw)', () => {
		const inline = leaf(prim('inl', 1, 1));
		const r = resolveGroup(group('inst', { w: 40, h: 26 }, inline, { def: 'nope' }), {
			version: 1,
			defs: []
		});
		expect(r.size).toEqual({ w: 40, h: 26 });
		expect((r.child as Leaf).id).toBe('inl');
	});

	it('resolveGroup params clone the child and never mutate the def', () => {
		const defChild = leaf(prim('spk', 10, 10, { type: 'sparkline', sensor: 'cpu.core.0' }));
		const def = {
			id: 'cg',
			name: 'core-graph',
			size: { w: 40, h: 26 },
			child: defChild,
			params: [{ key: 'core', target: 'unit.sensor' }]
		};
		const lib: Library = { version: 1, defs: [def] };
		const a = resolveGroup(
			group('A', { w: 40, h: 26 }, leaf(prim('x', 1, 1)), {
				def: 'cg',
				params: { core: 'cpu.core.5' }
			}),
			lib
		);
		const b = resolveGroup(
			group('B', { w: 40, h: 26 }, leaf(prim('x', 1, 1)), {
				def: 'cg',
				params: { core: 'cpu.core.9' }
			}),
			lib
		);
		expect((a.child as Leaf).unit).toMatchObject({ sensor: 'cpu.core.5' });
		expect((b.child as Leaf).unit).toMatchObject({ sensor: 'cpu.core.9' });
		// the def's own child is untouched
		expect((defChild.unit as WidgetInstance).sensor).toBe('cpu.core.0');
	});

	it('a `targets` (plural) spec writes ONE param value to several paths (e.g. a shared locale)', () => {
		const defChild = container('row', 'row', [
			leaf(prim('a', 10, 10, { config: { locale: 'en' } })),
			leaf(prim('b', 10, 10, { config: { locale: 'en' } }))
		]);
		const def = {
			id: 'd',
			name: 'd',
			size: { w: 40, h: 26 },
			child: defChild,
			params: [
				{
					key: 'lang',
					targets: ['children.0.unit.config.locale', 'children.1.unit.config.locale']
				}
			]
		};
		const lib: Library = { version: 1, defs: [def] };
		const r = resolveGroup(
			group('g', { w: 40, h: 26 }, leaf(prim('x', 1, 1)), { def: 'd', params: { lang: 'ja' } }),
			lib
		);
		const kids = (r.child as Container).children as Leaf[];
		expect((kids[0].unit as WidgetInstance).config?.locale).toBe('ja');
		expect((kids[1].unit as WidgetInstance).config?.locale).toBe('ja');
		// the def's own child is untouched (clone-before-apply)
		expect((defChild.children[0] as Leaf).unit).toMatchObject({ config: { locale: 'en' } });
	});

	it('no def and no library: uses the inline child + size verbatim', () => {
		const inline = leaf(prim('inl', 12, 8));
		const r = resolveGroup(group('inst', { w: 12, h: 8 }, inline)); // no library arg at all
		expect(r.size).toEqual({ w: 12, h: 8 });
		expect((r.child as Leaf).id).toBe('inl');
	});

	it('a group with no resolvable child falls back to an empty col + zero size', () => {
		// Bypass the constructor to model a malformed/empty group instance (no def, no inline child).
		const grp = { id: 'g', kind: 'group' as const } as unknown as Parameters<
			typeof resolveGroup
		>[0];
		const r = resolveGroup(grp);
		expect(r.size).toEqual({ w: 0, h: 0 }); // grp.size missing → {w:0,h:0} fallback
		const child = r.child as Container;
		expect(child.kind).toBe('col');
		expect(child.children).toEqual([]);
		expect(child.id).toBe('g:empty');
	});

	it('inline child WITH params but NO def specs: applyParams is a no-op (no specs to drive)', () => {
		const inline = leaf(prim('inl', 1, 1, { config: { core: 'orig' } }));
		// def-less group carrying params; there are no ParamSpecs (those live on the def) → no writes.
		const r = resolveGroup(group('inst', { w: 1, h: 1 }, inline, { params: { core: 'changed' } }));
		expect(((r.child as Leaf).unit as WidgetInstance).config?.core).toBe('orig');
	});

	it('a spec whose key is absent from the instance params is skipped', () => {
		const defChild = leaf(prim('spk', 10, 10, { config: { core: 'orig', label: 'orig' } }));
		const def = {
			id: 'd',
			name: 'd',
			size: { w: 40, h: 26 },
			child: defChild,
			params: [
				{ key: 'core', target: 'unit.config.core' },
				{ key: 'label', target: 'unit.config.label' } // this key is NOT supplied below
			]
		};
		const lib: Library = { version: 1, defs: [def] };
		const r = resolveGroup(
			group('g', { w: 40, h: 26 }, leaf(prim('x', 1, 1)), {
				def: 'd',
				params: { core: 'cpu.7' } // only `core`; `label` absent → its spec is skipped
			}),
			lib
		);
		const unit = (r.child as Leaf).unit as WidgetInstance;
		expect(unit.config?.core).toBe('cpu.7'); // applied
		expect(unit.config?.label).toBe('orig'); // untouched (key not in params)
	});

	it('default param target is fail-closed on a container-rooted child (no bogus unit grafted)', () => {
		const containerChild = container('inner', 'col', []);
		const def = {
			id: 'd',
			name: 'd',
			size: { w: 40, h: 40 },
			child: containerChild,
			params: [{ key: 'core' }] // no explicit target → default 'unit.config.core'
		};
		const lib: Library = { version: 1, defs: [def] };
		const r = resolveGroup(
			group('g', { w: 40, h: 40 }, leaf(prim('x', 1, 1)), { def: 'd', params: { core: 'cpu.5' } }),
			lib
		);
		expect('unit' in (r.child as Record<string, unknown>)).toBe(false);
	});
});

// ---- collectRenderables --------------------------------------------------

describe('collectRenderables', () => {
	it('pairs flow (select self, not movable) and floating (movable) primitives', () => {
		const mon: MonitorLayout = {
			root: container('root', 'col', [leaf(prim('F', 100, 20), { fr: 1 })], { align: 'stretch' }),
			floating: [leaf(prim('W', 160, 40))]
		};
		// Hand-built measured map: the root container box, the in-flow leaf F (fills it), and the
		// floating primitive W at its own rect.
		const solved: Solved = new Map([
			['root', { x: 0, y: 0, w: 1000, h: 200 }],
			['F', { x: 0, y: 0, w: 1000, h: 200 }],
			['W', { x: 300, y: 50, w: 160, h: 40 }]
		]);
		const rs = collectRenderables(mon, solved);
		const f = rs.find((r) => r.id === 'F');
		const w = rs.find((r) => r.id === 'W');
		expect(f).toMatchObject({
			selectId: 'F',
			movable: false,
			rect: { x: 0, y: 0, w: 1000, h: 200 }
		});
		expect(w).toMatchObject({
			selectId: 'W',
			movable: true,
			rect: { x: 300, y: 50, w: 160, h: 40 }
		});
	});

	it('emits group descendants (namespaced, selecting the group, not movable); not the group box', () => {
		const def = {
			id: 'cg',
			name: 'core-graph',
			size: { w: 40, h: 26 },
			child: leaf(prim('spk', 40, 26, { type: 'sparkline' }))
		};
		const lib: Library = { version: 1, defs: [def] };
		const g = group('g0', { w: 40, h: 26 }, leaf(prim('fb', 1, 1)), {
			def: 'cg',
			config: { x: 10, y: 20 }
		});
		const mon: MonitorLayout = { root: container('root', 'col', []), floating: [leaf(g)] };
		// The group descendant is namespaced `g0/spk`; the group box itself (`g0`) is intentionally
		// NOT in the map — collectRenderables must surface the descendant, not the box.
		const solved: Solved = new Map([
			['root', { x: 0, y: 0, w: 1000, h: 200 }],
			['g0/spk', { x: 10, y: 20, w: 40, h: 26 }]
		]);
		const rs = collectRenderables(mon, solved, lib);
		const spk = rs.find((r) => r.id === 'g0/spk');
		expect(spk).toMatchObject({
			selectId: 'g0',
			movable: false,
			rect: { x: 10, y: 20, w: 40, h: 26 }
		});
		expect(spk?.instance.type).toBe('sparkline');
		expect(rs.find((r) => r.id === 'g0')).toBeUndefined();
	});

	it('descends a group that sits IN THE FLOW TREE (not floating), namespacing + selecting it', () => {
		const def = {
			id: 'cg',
			name: 'core-graph',
			size: { w: 40, h: 26 },
			child: leaf(prim('spk', 40, 26, { type: 'sparkline' }))
		};
		const lib: Library = { version: 1, defs: [def] };
		// The group leaf lives inside the flow root (the `walk(monitor.root, …)` path), carrying its
		// own `def` so defSel falls through to node.unit.def.
		const g = group('gf', { w: 40, h: 26 }, leaf(prim('fb', 1, 1)), { def: 'cg' });
		const root = container('root', 'col', [leaf(g)], { align: 'stretch' });
		const mon: MonitorLayout = { root, floating: [] };
		const solved: Solved = new Map([
			['root', { x: 0, y: 0, w: 1000, h: 200 }],
			['gf/spk', { x: 0, y: 0, w: 40, h: 26 }]
		]);
		const rs = collectRenderables(mon, solved, lib);
		const spk = rs.find((r) => r.id === 'gf/spk');
		expect(spk).toMatchObject({
			selectId: 'gf', // the group is the selectable unit
			movable: false, // flow-tree group descendants are never movable
			groupId: 'gf',
			defId: 'cg', // node.unit.def threads through as defSel
			rect: { x: 0, y: 0, w: 40, h: 26 }
		});
		expect(spk?.instance.type).toBe('sparkline');
	});

	it('a FLOW-TREE group WITHOUT a def descends its inline child (no defId)', () => {
		// node.unit.def is undefined → `defSel ?? node.unit.def ?? null` takes the trailing `?? null`.
		const g = group('gn', { w: 30, h: 20 }, leaf(prim('inl', 30, 20, { type: 'text' })));
		const root = container('root', 'col', [leaf(g)], { align: 'stretch' });
		const mon: MonitorLayout = { root, floating: [] };
		const solved: Solved = new Map([
			['root', { x: 0, y: 0, w: 100, h: 100 }],
			['gn/inl', { x: 1, y: 2, w: 30, h: 20 }]
		]);
		const rs = collectRenderables(mon, solved);
		const inl = rs.find((r) => r.id === 'gn/inl');
		expect(inl).toMatchObject({ selectId: 'gn', groupId: 'gn', movable: false });
		expect(inl?.defId).toBeUndefined();
	});

	it('a FLOATING group WITHOUT a def resolves its inline child (defId omitted)', () => {
		// No def → resolveGroup falls back to the inline child; `lf.unit.def ?? null` takes the null arm.
		const g = group('gi', { w: 40, h: 26 }, leaf(prim('inl', 40, 26, { type: 'bar' })));
		const mon: MonitorLayout = { root: container('root', 'col', []), floating: [leaf(g)] };
		const solved: Solved = new Map([
			['root', { x: 0, y: 0, w: 1000, h: 200 }],
			['gi/inl', { x: 5, y: 6, w: 40, h: 26 }]
		]);
		const rs = collectRenderables(mon, solved);
		const inl = rs.find((r) => r.id === 'gi/inl');
		expect(inl).toMatchObject({
			selectId: 'gi',
			groupId: 'gi',
			movable: false,
			rect: { x: 5, y: 6, w: 40, h: 26 }
		});
		expect(inl?.defId).toBeUndefined(); // def-less group → no defId css hook
		expect(inl?.instance.type).toBe('bar');
	});
});

// ---- collectContainerRects -----------------------------------------------

describe('collectContainerRects', () => {
	it('returns the root and every nested container box, with kind', () => {
		const root = container(
			'root',
			'col',
			[
				container('row1', 'row', [leaf(prim('A', 40, 20)), leaf(prim('B', 40, 20))], {
					align: 'stretch'
				})
			],
			{ align: 'stretch' }
		);
		const mon: MonitorLayout = { root, floating: [] };
		const solved: Solved = new Map([
			['root', { x: 0, y: 0, w: 200, h: 100 }],
			['row1', { x: 0, y: 0, w: 200, h: 100 }]
		]);
		const boxes = collectContainerRects(mon, solved);
		const byId = Object.fromEntries(boxes.map((b) => [b.id, b]));
		expect(byId['root']).toMatchObject({ kind: 'col', rect: { x: 0, y: 0, w: 200, h: 100 } });
		expect(byId['row1']?.kind).toBe('row');
		expect(boxes).toHaveLength(2);
	});

	it('does not descend into group internals (only flow-tree containers)', () => {
		// collectContainerRects takes no library — it walks the monitor's own flow tree only — so the
		// group's def need not be resolved here; an inline def reference on the group leaf is enough.
		const root = container(
			'root',
			'col',
			[leaf(group('g0', { w: 40, h: 26 }, leaf(prim('fb', 1, 1)), { def: 'cg' }))],
			{
				align: 'stretch'
			}
		);
		const mon: MonitorLayout = { root, floating: [] };
		// Map carries the group's internal `innerDef` box too — collectContainerRects must still NOT
		// surface it, because it walks only the monitor's own flow tree (not group def subtrees).
		const solved: Solved = new Map([
			['root', { x: 0, y: 0, w: 100, h: 100 }],
			['g0/innerDef', { x: 0, y: 0, w: 40, h: 26 }]
		]);
		const boxes = collectContainerRects(mon, solved);
		// Only the flow root is a container here; the group's internal 'innerDef' is not surfaced.
		expect(boxes.map((b) => b.id)).toEqual(['root']);
	});

	it('surfaces a freshly added empty pane (fr basis) so it is visible', () => {
		// Mirrors addContainer: an empty fr:1 grid added to the root fills the work area.
		const grid = container('grid-x', 'grid', [], { cols: 2, basis: { fr: 1 } });
		const root = container('root', 'col', [grid], { align: 'stretch' });
		const mon: MonitorLayout = { root, floating: [] };
		const solved: Solved = new Map([
			['root', { x: 0, y: 0, w: 200, h: 120 }],
			['grid-x', { x: 0, y: 0, w: 200, h: 120 }]
		]);
		const boxes = collectContainerRects(mon, solved);
		const gridBox = boxes.find((b) => b.id === 'grid-x');
		expect(gridBox?.kind).toBe('grid');
		expect(gridBox?.rect).toEqual({ x: 0, y: 0, w: 200, h: 120 }); // fills the root
	});
});

describe('collectGridPlaceholders', () => {
	it('an empty grid outlines one row of `cols` cells', () => {
		const grid = container('g', 'grid', [], { cols: 2, basis: { fr: 1 } });
		const root = container('root', 'col', [grid], { align: 'stretch' });
		const mon: MonitorLayout = { root, floating: [] };
		// Placeholders derive cell rects via gridCellRects from the grid CONTAINER box, so the map
		// only needs the grid's own box (200×100). 2 cols → two 100-wide cells.
		const solved: Solved = new Map([['g', { x: 0, y: 0, w: 200, h: 100 }]]);
		const cells = collectGridPlaceholders(mon, solved);
		expect(cells).toHaveLength(2);
		expect(cells[0]).toEqual({ gridId: 'g', index: 0, rect: { x: 0, y: 0, w: 100, h: 100 } });
		expect(cells[1]).toEqual({ gridId: 'g', index: 1, rect: { x: 100, y: 0, w: 100, h: 100 } });
	});

	it('a partial grid outlines only the empty trailing cells', () => {
		const grid = container('g', 'grid', [leaf(prim('A', 10, 10))], { cols: 2, basis: { fr: 1 } });
		const root = container('root', 'col', [grid], { align: 'stretch' });
		const mon: MonitorLayout = { root, floating: [] };
		const solved: Solved = new Map([['g', { x: 0, y: 0, w: 200, h: 100 }]]);
		const cells = collectGridPlaceholders(mon, solved);
		expect(cells).toHaveLength(1); // cell 0 filled by A, cell 1 is the placeholder
		expect(cells[0]).toEqual({ gridId: 'g', index: 1, rect: { x: 100, y: 0, w: 100, h: 100 } });
	});
});

// ---- gridCellRects (takes a box, no solver) ------------------------------

describe('non-uniform grid (fixed cell width/height + aspect)', () => {
	it('uniform when no cell fixes a size (unchanged behaviour)', () => {
		const grid = container('g', 'grid', [leaf(prim('A', 10, 10)), leaf(prim('B', 10, 10))], {
			cols: 2
		});
		const cells = gridCellRects(grid, { x: 0, y: 0, w: 200, h: 100 });
		expect(cells[0]).toEqual({ x: 0, y: 0, w: 100, h: 100 });
		expect(cells[1]).toEqual({ x: 100, y: 0, w: 100, h: 100 });
	});

	it('a fixed-width cell takes that column width; the rest split the remainder', () => {
		const c0 = container('c0', 'col', [leaf(prim('A', 10, 10))], { cellW: 100 });
		const grid = container('g', 'grid', [c0, leaf(prim('B', 10, 10)), leaf(prim('C', 10, 10))], {
			cols: 3
		});
		const cells = gridCellRects(grid, { x: 0, y: 0, w: 300, h: 100 });
		expect(cells[0]).toEqual({ x: 0, y: 0, w: 100, h: 100 }); // fixed column
		expect(cells[1]).toEqual({ x: 100, y: 0, w: 100, h: 100 }); // (300-100)/2
		expect(cells[2]).toEqual({ x: 200, y: 0, w: 100, h: 100 });
	});

	it('a fixed-height cell sets its row height; the flexible row takes the remainder', () => {
		// 1 col × 2 rows over 100×200; row 0 fixed 50 → row 1 = 150.
		const c0 = container('c0', 'col', [leaf(prim('A', 10, 10))], { cellH: 50 });
		const grid = container('g', 'grid', [c0, leaf(prim('B', 10, 10))], { cols: 1 });
		const cells = gridCellRects(grid, { x: 0, y: 0, w: 100, h: 200 });
		expect(cells[0]).toEqual({ x: 0, y: 0, w: 100, h: 50 });
		expect(cells[1]).toEqual({ x: 0, y: 50, w: 100, h: 150 });
	});

	it('colFr weights the flexible columns (2:1 over 300 → 200 / 100)', () => {
		const grid = container('g', 'grid', [leaf(prim('A', 10, 10)), leaf(prim('B', 10, 10))], {
			cols: 2,
			colFr: [2, 1]
		});
		const cells = gridCellRects(grid, { x: 0, y: 0, w: 300, h: 100 });
		expect(cells[0]).toEqual({ x: 0, y: 0, w: 200, h: 100 });
		expect(cells[1]).toEqual({ x: 200, y: 0, w: 100, h: 100 });
	});

	it('rowFr weights the flexible rows (1:3 over 200 → 50 / 150)', () => {
		const grid = container('g', 'grid', [leaf(prim('A', 10, 10)), leaf(prim('B', 10, 10))], {
			cols: 1,
			rowFr: [1, 3]
		});
		const cells = gridCellRects(grid, { x: 0, y: 0, w: 100, h: 200 });
		expect(cells[0]).toEqual({ x: 0, y: 0, w: 100, h: 50 });
		expect(cells[1]).toEqual({ x: 0, y: 50, w: 100, h: 150 });
	});

	it('a grid with no explicit cols lays out a single column per row', () => {
		// cols omitted → 1; two children → two rows over a 100×200 box → two stacked 100×100 cells.
		const grid = container('g', 'grid', [leaf(prim('A', 10, 10)), leaf(prim('B', 10, 10))]);
		const cells = gridCellRects(grid, { x: 0, y: 0, w: 100, h: 200 });
		expect(cells).toHaveLength(2);
		expect(cells[0]).toEqual({ x: 0, y: 0, w: 100, h: 100 });
		expect(cells[1]).toEqual({ x: 0, y: 100, w: 100, h: 100 });
	});

	it('when every column is fixed there is no flexible pool to split (tracks take their fixed px)', () => {
		// Both columns carry a cellW → flexWeight is 0; each track is exactly its fixed width regardless
		// of the box width (the box is wider than the fixed total).
		const c0 = container('c0', 'col', [leaf(prim('A', 5, 5))], { cellW: 60 });
		const c1 = container('c1', 'col', [leaf(prim('B', 5, 5))], { cellW: 40 });
		const grid = container('g', 'grid', [c0, c1], { cols: 2 });
		const cells = gridCellRects(grid, { x: 0, y: 0, w: 300, h: 100 });
		expect(cells[0].w).toBe(60);
		expect(cells[1].w).toBe(40);
	});

	it('a fixed column is untouched by colFr; only the FLEXIBLE rest is weighted', () => {
		// col 0 fixed 100; cols 1,2 flexible with weights 1:3 over the remaining 200 → 50 / 150.
		const c0 = container('c0', 'col', [leaf(prim('A', 10, 10))], { cellW: 100 });
		const grid = container('g', 'grid', [c0, leaf(prim('B', 10, 10)), leaf(prim('C', 10, 10))], {
			cols: 3,
			colFr: [1, 1, 3]
		});
		const cells = gridCellRects(grid, { x: 0, y: 0, w: 300, h: 100 });
		expect(cells[0].w).toBe(100); // fixed
		expect(cells[1].w).toBe(50); // 200 * 1/4
		expect(cells[2].w).toBe(150); // 200 * 3/4
	});
});

// ---- splitters (interactive row/col resize) ------------------------------

describe('collectSplitters', () => {
	const frLeaf = (id: string): Leaf => ({ ...leaf(prim(id, 10, 10)), basis: { fr: 1 } });

	it('one bar between two fr children of a row (vertical, at the boundary)', () => {
		const row = container('r', 'row', [frLeaf('a'), frLeaf('b')]);
		const mon: MonitorLayout = { root: container('root', 'col', [row]), floating: [] };
		const solved: Solved = new Map([
			['a', { x: 0, y: 0, w: 100, h: 50 }],
			['b', { x: 100, y: 0, w: 100, h: 50 }]
		]);
		const sp = collectSplitters(mon, solved);
		expect(sp).toHaveLength(1);
		expect(sp[0]).toMatchObject({
			axis: 'row',
			aId: 'a',
			bId: 'b',
			frA: 1,
			frB: 1,
			mainA: 100,
			mainB: 100
		});
		expect(sp[0].rect.x).toBeCloseTo(100 - 4); // centred on the boundary, 8px bar
	});

	it('skips a pair that is not fr↔fr (only the proportional pool resizes)', () => {
		const row = container('r', 'row', [
			frLeaf('a'),
			{ ...leaf(prim('b', 10, 10)), basis: 'content' }
		]);
		const mon: MonitorLayout = { root: container('root', 'col', [row]), floating: [] };
		const solved: Solved = new Map([
			['a', { x: 0, y: 0, w: 100, h: 50 }],
			['b', { x: 100, y: 0, w: 100, h: 50 }]
		]);
		expect(collectSplitters(mon, solved)).toHaveLength(0);
	});

	it('skips an fr↔fr pair when a child has no measured rect yet', () => {
		const row = container('r', 'row', [frLeaf('a'), frLeaf('b')]);
		const mon: MonitorLayout = { root: container('root', 'col', [row]), floating: [] };
		// `b` is absent from the solved map (not yet measured) → the boundary can't be placed.
		const solved: Solved = new Map([['a', { x: 0, y: 0, w: 100, h: 50 }]]);
		expect(collectSplitters(mon, solved)).toHaveLength(0);
	});

	it('a col with three fr children yields two horizontal bars', () => {
		const col = container('c', 'col', [frLeaf('a'), frLeaf('b'), frLeaf('d')]);
		const mon: MonitorLayout = { root: col, floating: [] };
		const solved: Solved = new Map([
			['a', { x: 0, y: 0, w: 100, h: 30 }],
			['b', { x: 0, y: 30, w: 100, h: 30 }],
			['d', { x: 0, y: 60, w: 100, h: 30 }]
		]);
		const sp = collectSplitters(mon, solved);
		expect(sp).toHaveLength(2);
		expect(sp.every((s) => s.axis === 'col')).toBe(true);
	});
});

describe('collectSplitters — grid tracks', () => {
	it('a 2-col grid yields one vertical column splitter carrying its track indices', () => {
		const grid = container('g', 'grid', [leaf(prim('A', 10, 10)), leaf(prim('B', 10, 10))], {
			cols: 2
		});
		const mon: MonitorLayout = { root: container('root', 'col', [grid]), floating: [] };
		const solved: Solved = new Map([['g', { x: 0, y: 0, w: 200, h: 100 }]]);
		const sp = collectSplitters(mon, solved);
		expect(sp).toHaveLength(1);
		expect(sp[0]).toMatchObject({
			containerId: 'g',
			axis: 'row', // vertical bar
			frA: 1,
			frB: 1,
			track: { which: 'col', a: 0, b: 1 }
		});
		expect(sp[0].rect.x).toBeCloseTo(100 - 4); // centred on the boundary, 8px bar
	});

	it('a 2×2 grid yields one column splitter + one row splitter', () => {
		const cells = [
			leaf(prim('A', 10, 10)),
			leaf(prim('B', 10, 10)),
			leaf(prim('C', 10, 10)),
			leaf(prim('D', 10, 10))
		];
		const grid = container('g', 'grid', cells, { cols: 2, rows: 2 });
		const mon: MonitorLayout = { root: grid, floating: [] };
		const solved: Solved = new Map([['g', { x: 0, y: 0, w: 200, h: 100 }]]);
		const sp = collectSplitters(mon, solved);
		expect(sp.filter((s) => s.track?.which === 'col')).toHaveLength(1);
		expect(sp.filter((s) => s.track?.which === 'row')).toHaveLength(1);
	});

	it('reflects stored colFr weights as the splitter start fr', () => {
		const grid = container('g', 'grid', [leaf(prim('A', 10, 10)), leaf(prim('B', 10, 10))], {
			cols: 2,
			colFr: [3, 1]
		});
		const mon: MonitorLayout = { root: container('root', 'col', [grid]), floating: [] };
		const solved: Solved = new Map([['g', { x: 0, y: 0, w: 200, h: 100 }]]);
		const sp = collectSplitters(mon, solved);
		expect(sp[0]).toMatchObject({ frA: 3, frB: 1 });
	});

	it('skips a boundary touching a FIXED (cellW) track', () => {
		const c0 = container('c0', 'col', [leaf(prim('A', 10, 10))], { cellW: 80 });
		const grid = container('g', 'grid', [c0, leaf(prim('B', 10, 10))], { cols: 2 });
		const mon: MonitorLayout = { root: container('root', 'col', [grid]), floating: [] };
		const solved: Solved = new Map([['g', { x: 0, y: 0, w: 200, h: 100 }]]);
		expect(collectSplitters(mon, solved)).toHaveLength(0);
	});

	it('skips a row boundary whose TRAILING row track is fixed (cellH on the next row)', () => {
		// 1 col × 2 rows; row 0 flexible, row 1 fixed (cellH). Boundary 0↔1: rowFixed[0] null (left arm
		// false) but rowFixed[1] non-null (right arm true) → the boundary is skipped.
		const r1 = container('r1', 'col', [leaf(prim('B', 10, 10))], { cellH: 40 });
		const grid = container('g', 'grid', [leaf(prim('A', 10, 10)), r1], { cols: 1 });
		const mon: MonitorLayout = { root: container('root', 'col', [grid]), floating: [] };
		const solved: Solved = new Map([['g', { x: 0, y: 0, w: 100, h: 200 }]]);
		expect(collectSplitters(mon, solved).filter((s) => s.track?.which === 'row')).toHaveLength(0);
	});

	it('a grid with no explicit cols (1-col default) and an explicit rows minimum yields row splitters', () => {
		// cols omitted → 1; rows:3 minimum with 2 children → 3 row tracks → 2 row splitters, 0 col.
		const grid = container('g', 'grid', [leaf(prim('A', 10, 10)), leaf(prim('B', 10, 10))], {
			rows: 3
		});
		const mon: MonitorLayout = { root: container('root', 'col', [grid]), floating: [] };
		const solved: Solved = new Map([['g', { x: 0, y: 0, w: 200, h: 300 }]]);
		const sp = collectSplitters(mon, solved);
		expect(sp.filter((s) => s.track?.which === 'col')).toHaveLength(0);
		expect(sp.filter((s) => s.track?.which === 'row')).toHaveLength(2);
	});
});

describe('resizeSplit', () => {
	it('keeps the combined fr constant while re-dividing the ratio', () => {
		// snap off to test the raw ratio (delta +20 → 120/200 = 0.6, but 120 is within 14px of the 2/3 snap).
		const { frA, frB } = resizeSplit(100, 100, 1, 1, 20, { snapPx: 0 });
		expect(frA + frB).toBeCloseTo(2);
		expect(frA).toBeGreaterThan(frB); // A grew
		expect(frA).toBeCloseTo(1.2); // fraction 0.6 × combined 2
	});

	it('snaps the boundary to a 1/3 fraction when near', () => {
		const { frA, frB } = resizeSplit(100, 100, 1, 1, -32, { snapPx: 14 }); // newA 68 ≈ 1/3·200 (66.7)
		expect(frA).toBeCloseTo((1 / 3) * 2, 2);
		expect(frB).toBeCloseTo((2 / 3) * 2, 2);
	});

	it('clamps so neither side drops below the minimum', () => {
		const { frA } = resizeSplit(100, 100, 1, 1, -500, { minPx: 16, snapPx: 0 });
		expect(frA).toBeCloseTo((16 / 200) * 2, 2); // newA pinned to 16px
	});

	it('uses default snapPx/minPx when no opts are passed', () => {
		// No opts arg → snapPx 14, minPx 16. delta +200 over 200px clamps A to total-minPx = 184.
		const { frA, frB } = resizeSplit(100, 100, 1, 1, 200);
		expect(frA + frB).toBeCloseTo(2);
		// 184/200 = 0.92, within 14px of no snap; raw fraction 0.92 → frA = 0.92*2 = 1.84.
		expect(frA).toBeCloseTo(1.84, 2);
	});

	it('returns the weights unchanged when the combined size is non-positive', () => {
		// total = 0 → the divide-by-zero guard returns the inputs verbatim.
		expect(resizeSplit(0, 0, 1, 1, 50)).toEqual({ frA: 1, frB: 1 });
	});

	it('returns the weights unchanged when the combined fr is non-positive', () => {
		// combinedFr = 0 → same guard.
		expect(resizeSplit(100, 100, 0, 0, 50)).toEqual({ frA: 0, frB: 0 });
	});
});
