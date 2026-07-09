import { describe, expect, it } from 'vitest';
import type { WidgetInstance } from './layout';
import {
	container,
	group,
	isContainer,
	leaf,
	type Container,
	type Group,
	type Library
} from './layoutTree';
import {
	allContainers,
	collapseContainer,
	dropTarget,
	findNode,
	findParent,
	flowLeaves,
	insertChild,
	moveNode,
	outlineRows,
	removeNode,
	replaceNode,
	ungroupNode,
	updateContainer,
	updateNode
} from './layoutEdit';
import type { Rect } from './layout';

const prim = (id: string): WidgetInstance => ({
	id,
	type: 'gauge',
	rect: { x: 0, y: 0, w: 10, h: 10 },
	config: {}
});

// root(col)
//   ├ rowA(row)
//   │   ├ A
//   │   └ B
//   └ C
const tree = (): Container =>
	container('root', 'col', [
		container('rowA', 'row', [leaf(prim('A')), leaf(prim('B'))]),
		leaf(prim('C'))
	]);

describe('replaceNode', () => {
	it('replaces a nested leaf in place, preserving its position', () => {
		const next = replaceNode(tree(), 'B', leaf(prim('B2')));
		const rowA = findNode(next, 'rowA') as Container;
		expect(rowA.children.map((c) => c.id)).toEqual(['A', 'B2']);
		// untouched siblings keep identity-equivalent content
		expect(findNode(next, 'C')).toBeTruthy();
	});

	it('replaces a nested container subtree', () => {
		const next = replaceNode(tree(), 'rowA', container('rowA', 'grid', [leaf(prim('X'))]));
		const rowA = findNode(next, 'rowA') as Container;
		expect(rowA.kind).toBe('grid');
		expect(rowA.children.map((c) => c.id)).toEqual(['X']);
	});

	it('is a no-op clone when the id is absent', () => {
		const next = replaceNode(tree(), 'nope', leaf(prim('Z')));
		expect(outlineRows(next).map((r) => r.node.id)).toEqual(
			outlineRows(tree()).map((r) => r.node.id)
		);
	});

	it('refuses to replace the root with a leaf, but accepts a container', () => {
		expect(replaceNode(tree(), 'root', leaf(prim('Z'))).id).toBe('root');
		const replaced = replaceNode(tree(), 'root', container('root', 'row', []));
		expect(replaced.kind).toBe('row');
	});
});

describe('findNode / findParent', () => {
	it('finds the root, a nested container, and a nested leaf', () => {
		const t = tree();
		expect(findNode(t, 'root')?.id).toBe('root');
		expect(findNode(t, 'rowA')?.id).toBe('rowA');
		expect(findNode(t, 'A')?.id).toBe('A');
		expect(findNode(t, 'nope')).toBeNull();
	});

	it('findParent returns the containing container, null for root/absent', () => {
		const t = tree();
		expect(findParent(t, 'A')?.id).toBe('rowA');
		expect(findParent(t, 'rowA')?.id).toBe('root');
		expect(findParent(t, 'C')?.id).toBe('root');
		expect(findParent(t, 'root')).toBeNull();
		expect(findParent(t, 'nope')).toBeNull();
	});
});

describe('collapseContainer', () => {
	it('flattens split sub-cells one level and drops the empty ones', () => {
		// cell = col[ keep=col[W1], empty=col[] ]  → col[W1]
		const cell = container('cell', 'col', [
			container('keep', 'col', [leaf(prim('W1'))]),
			container('empty', 'col', [])
		]);
		const root = container('root', 'col', [cell]);
		const out = findNode(collapseContainer(root, 'cell'), 'cell') as Container;
		expect(out.children.map((c) => c.id)).toEqual(['W1']);
	});

	it('pulls every filled sub-cell up, keeps the cell kind, drops empties', () => {
		const cell = container('cell', 'row', [
			container('a', 'col', [leaf(prim('W1'))]),
			container('b', 'col', [leaf(prim('W2'))]),
			container('e', 'col', [])
		]);
		const root = container('root', 'col', [cell]);
		const out = findNode(collapseContainer(root, 'cell'), 'cell') as Container;
		expect(out.children.map((c) => c.id)).toEqual(['W1', 'W2']);
		expect(out.kind).toBe('row');
	});

	it('keeps leaf children as-is alongside flattened sub-cells', () => {
		const cell = container('cell', 'col', [
			leaf(prim('W1')),
			container('sub', 'col', [leaf(prim('W2'))])
		]);
		const root = container('root', 'col', [cell]);
		const out = findNode(collapseContainer(root, 'cell'), 'cell') as Container;
		expect(out.children.map((c) => c.id)).toEqual(['W1', 'W2']);
	});

	it('keeps a pulled-up sub-container that still holds a widget deeper down, drops empty ones', () => {
		// cell = col[ sub=col[inner=row[W1]], sub2=col[innerEmpty=row[]] ] → col[inner]
		const cell = container('cell', 'col', [
			container('sub', 'col', [container('inner', 'row', [leaf(prim('W1'))])]),
			container('sub2', 'col', [container('innerEmpty', 'row', [])])
		]);
		const root = container('root', 'col', [cell]);
		const out = findNode(collapseContainer(root, 'cell'), 'cell') as Container;
		expect(out.children.map((c) => c.id)).toEqual(['inner']);
	});

	it('is a no-op when the id names a leaf, not a container', () => {
		const r = collapseContainer(tree(), 'A');
		expect((findNode(r, 'rowA') as Container).children.map((c) => c.id)).toEqual(['A', 'B']);
	});
});

describe('insertChild', () => {
	it('appends by default and inserts at an index', () => {
		const t = tree();
		const appended = insertChild(t, 'rowA', leaf(prim('D')));
		expect((findNode(appended, 'rowA') as Container).children.map((c) => c.id)).toEqual([
			'A',
			'B',
			'D'
		]);
		const inserted = insertChild(t, 'rowA', leaf(prim('D')), 1);
		expect((findNode(inserted, 'rowA') as Container).children.map((c) => c.id)).toEqual([
			'A',
			'D',
			'B'
		]);
	});

	it('does not mutate the original tree', () => {
		const t = tree();
		insertChild(t, 'rowA', leaf(prim('D')));
		expect((findNode(t, 'rowA') as Container).children).toHaveLength(2);
	});

	it('clamps an out-of-range index', () => {
		const t = tree();
		const r = insertChild(t, 'rowA', leaf(prim('D')), 99);
		expect((findNode(r, 'rowA') as Container).children.map((c) => c.id)).toEqual(['A', 'B', 'D']);
	});

	it('is a no-op when the target parent is a leaf, not a container', () => {
		const r = insertChild(tree(), 'A', leaf(prim('D')));
		expect(flowLeaves(r).map((l) => l.id)).toEqual(['A', 'B', 'C']);
	});
});

describe('removeNode', () => {
	it('removes a leaf', () => {
		const r = removeNode(tree(), 'B');
		expect((findNode(r, 'rowA') as Container).children.map((c) => c.id)).toEqual(['A']);
	});

	it('removes a container and its subtree', () => {
		const r = removeNode(tree(), 'rowA');
		expect(r.children.map((c) => c.id)).toEqual(['C']);
		expect(findNode(r, 'A')).toBeNull();
	});

	it('is a no-op for the root or an absent id, and does not mutate', () => {
		const t = tree();
		expect(removeNode(t, 'root').children).toHaveLength(2);
		expect(removeNode(t, 'nope').children).toHaveLength(2);
		expect(t.children).toHaveLength(2);
	});
});

describe('moveNode', () => {
	it('reorders within the same parent', () => {
		// move A to the end of rowA
		const r = moveNode(tree(), 'A', 'rowA', 2);
		expect((findNode(r, 'rowA') as Container).children.map((c) => c.id)).toEqual(['B', 'A']);
	});

	it('reparents across containers at an index', () => {
		const r = moveNode(tree(), 'C', 'rowA', 0);
		expect((findNode(r, 'rowA') as Container).children.map((c) => c.id)).toEqual(['C', 'A', 'B']);
		expect(r.children.map((c) => c.id)).toEqual(['rowA']);
	});

	it('refuses to move a node into its own subtree (cycle guard)', () => {
		const r = moveNode(tree(), 'rowA', 'rowA', 0);
		// unchanged structure
		expect(r.children.map((c) => c.id)).toEqual(['rowA', 'C']);
	});

	it('refuses to move a container into one of its own descendants', () => {
		// rowA → its own child A would orphan the subtree; the deep cycle guard refuses.
		const r = moveNode(tree(), 'rowA', 'A', 0);
		expect(r.children.map((c) => c.id)).toEqual(['rowA', 'C']);
		expect((findNode(r, 'rowA') as Container).children.map((c) => c.id)).toEqual(['A', 'B']);
	});

	it('is a no-op for an absent node', () => {
		const r = moveNode(tree(), 'nope', 'rowA', 0);
		expect(r.children.map((c) => c.id)).toEqual(['rowA', 'C']);
	});
});

describe('updateNode / updateContainer', () => {
	it('patches a container in place (immutably)', () => {
		const t = tree();
		const r = updateContainer(t, 'rowA', { gap: 12, align: 'center', cols: 3 });
		expect(findNode(r, 'rowA')).toMatchObject({ gap: 12, align: 'center', cols: 3 });
		expect(findNode(t, 'rowA')).not.toHaveProperty('gap'); // original untouched
	});

	it('updateNode replaces a matched node via fn', () => {
		const r = updateNode(tree(), 'A', (n) => (isContainer(n) ? n : { ...n, basis: { fr: 1 } }));
		expect(findNode(r, 'A')).toMatchObject({ basis: { fr: 1 } });
	});

	it('updateContainer is a no-op when the id names a leaf, not a container', () => {
		const t = tree();
		const r = updateContainer(t, 'A', { gap: 12 });
		expect(findNode(r, 'A')).toEqual(findNode(t, 'A'));
	});
});

describe('flowLeaves / allContainers', () => {
	it('flowLeaves collects every leaf in document order', () => {
		expect(flowLeaves(tree()).map((l) => l.id)).toEqual(['A', 'B', 'C']);
	});

	it('allContainers lists root first, then nested containers', () => {
		expect(allContainers(tree()).map((c) => c.id)).toEqual(['root', 'rowA']);
	});

	it('outlineRows flattens (excluding root) with depth + parent + index', () => {
		const rows = outlineRows(tree());
		expect(rows.map((r) => `${r.node.id}@${r.depth}`)).toEqual(['rowA@0', 'A@1', 'B@1', 'C@0']);
		const a = rows.find((r) => r.node.id === 'A');
		expect(a).toMatchObject({ parentId: 'rowA', index: 0, siblingCount: 2 });
		const c = rows.find((r) => r.node.id === 'C');
		expect(c).toMatchObject({ parentId: 'root', index: 1, siblingCount: 2 });
		// Tree-line guides: a top-level row has no ancestor lanes; A/B sit under rowA, which is NOT
		// root's last child (C follows), so their single ancestor lane keeps a continuing vertical.
		expect(rows.find((r) => r.node.id === 'rowA')?.ancestorsLast).toEqual([]);
		expect(a?.ancestorsLast).toEqual([false]);
		expect(c?.ancestorsLast).toEqual([]);
	});
});

describe('ungroupNode', () => {
	const def = {
		id: 'd',
		name: 'panel',
		size: { w: 1, h: 1 },
		child: container('inner', 'row', [leaf(prim('X')), leaf(prim('Y'))])
	};
	const lib: Library = { version: 1, defs: [def] };

	it("replaces a def-backed group leaf with a clone of the def's child", () => {
		const root = container('root', 'col', [
			leaf(group('g', { w: 1, h: 1 }, leaf(prim('fallback')), { def: 'd' })),
			leaf(prim('Z'))
		]);
		const r = ungroupNode(root, 'g', lib);
		expect(r.children.map((c) => c.id)).toEqual(['inner', 'Z']);
		expect(findNode(r, 'X')?.id).toBe('X');
		expect(findNode(r, 'g')).toBeNull();
		// def is untouched (clone), and the original tree is not mutated
		expect((def.child as Container).children).toHaveLength(2);
		expect(findNode(root, 'inner')).toBeNull();
	});

	it('falls back to the inline child when there is no def', () => {
		const root = container('root', 'col', [leaf(group('g', { w: 1, h: 1 }, leaf(prim('only'))))]);
		const r = ungroupNode(root, 'g');
		expect(findNode(r, 'only')?.id).toBe('only');
	});

	it('is a no-op for a non-group id', () => {
		const t = tree();
		expect(ungroupNode(t, 'A').children.map((c) => c.id)).toEqual(['rowA', 'C']);
	});

	it('removes a group with no resolvable child (no def match, no inline child)', () => {
		// A group loaded from persisted JSON can arrive with no inline child; with nothing to
		// unwrap to, ungrouping drops the group leaf entirely.
		const childless = { id: 'g', kind: 'group', size: { w: 1, h: 1 } } as Group;
		const root = container('root', 'col', [leaf(childless), leaf(prim('Z'))]);
		expect(ungroupNode(root, 'g').children.map((c) => c.id)).toEqual(['Z']);
	});
});

describe('dropTarget', () => {
	// root(row) [A,B,C], laid out left→right, 100px wide cells.
	const rowTree = () =>
		container('root', 'row', [leaf(prim('A')), leaf(prim('B')), leaf(prim('C'))]);
	const rowSolved = new Map<string, Rect>([
		['A', { x: 0, y: 0, w: 100, h: 50 }],
		['B', { x: 100, y: 0, w: 100, h: 50 }],
		['C', { x: 200, y: 0, w: 100, h: 50 }]
	]);

	it('drops into the near half of the hovered leaf (row → x), excluding the dragged one', () => {
		// hover A's right half while dragging C → between A and B (index 1 of [A,B])
		expect(dropTarget(rowTree(), rowSolved, { x: 60, y: 25 }, 'C')).toEqual({
			parentId: 'root',
			index: 1
		});
		// hover B's left half while dragging A → before B (index 0 of [B,C])
		expect(dropTarget(rowTree(), rowSolved, { x: 110, y: 25 }, 'A')).toEqual({
			parentId: 'root',
			index: 0
		});
	});

	it('uses the y axis for a col parent', () => {
		const col = container('root', 'col', [leaf(prim('A')), leaf(prim('B'))]);
		const solved = new Map<string, Rect>([
			['A', { x: 0, y: 0, w: 100, h: 50 }],
			['B', { x: 0, y: 50, w: 100, h: 50 }]
		]);
		// hover B's bottom half dragging A → after B (index 1 of [B])
		expect(dropTarget(col, solved, { x: 50, y: 90 }, 'A')).toEqual({ parentId: 'root', index: 1 });
	});

	it('returns null when the point is over no flow leaf (→ float)', () => {
		expect(dropTarget(rowTree(), rowSolved, { x: 999, y: 999 }, 'A')).toBeNull();
	});

	it('drops into an empty (non-root) container the point is over, appending at its end', () => {
		const grid = container('g', 'grid', [], { cols: 2 });
		const root = container('root', 'col', [grid]);
		const solved = new Map<string, Rect>([
			['root', { x: 0, y: 0, w: 200, h: 200 }],
			['g', { x: 0, y: 0, w: 200, h: 100 }]
		]);
		expect(dropTarget(root, solved, { x: 50, y: 50 }, 'W')).toEqual({ parentId: 'g', index: 0 });
	});

	it('does not fall into a row/col ROOT (bare-canvas drop still floats)', () => {
		const root = container('root', 'col', []);
		const solved = new Map<string, Rect>([['root', { x: 0, y: 0, w: 200, h: 200 }]]);
		expect(dropTarget(root, solved, { x: 50, y: 50 }, 'W')).toBeNull();
	});

	it('DOES fall into a grid ROOT (its cells are drop targets)', () => {
		const root = container('root', 'grid', [], { cols: 2 });
		const solved = new Map<string, Rect>([['root', { x: 0, y: 0, w: 200, h: 200 }]]);
		expect(dropTarget(root, solved, { x: 50, y: 50 }, 'W')).toEqual({ parentId: 'root', index: 0 });
	});

	it('drops INTO an occupied grid cell interior (container → into, bare leaf → merge)', () => {
		// grid g over [c0 (a cell-container with A), L1 (a bare-leaf cell)], 2 cols → cells at
		// (0,0,100,100) and (100,0,100,100).
		const c0 = container('c0', 'col', [leaf(prim('A'))], { align: 'stretch' });
		const grid = container('g', 'grid', [c0, leaf(prim('L1'))], { cols: 2 });
		const root = container('root', 'col', [grid], { align: 'stretch' });
		const solved = new Map<string, Rect>([
			['root', { x: 0, y: 0, w: 200, h: 100 }],
			['g', { x: 0, y: 0, w: 200, h: 100 }]
		]);
		// interior of cell 0 (a container) → drop into it (append after A)
		expect(dropTarget(root, solved, { x: 50, y: 50 }, 'W')).toEqual({
			parentId: 'c0',
			index: 1,
			into: true
		});
		// interior of cell 1 (a bare leaf) → merge that leaf with the dropped node
		expect(dropTarget(root, solved, { x: 150, y: 50 }, 'W')).toEqual({
			parentId: 'g',
			index: 1,
			merge: 'L1'
		});
		// near the cell EDGE (outer band) → falls through to before/after (not into)
		const edge = dropTarget(root, solved, { x: 95, y: 50 }, 'W');
		expect(edge?.into).toBeUndefined();
		expect(edge?.merge).toBeUndefined();
	});

	it('skips grid-cell interiors when intoCells is false (plain before/after)', () => {
		const c0 = container('c0', 'col', [leaf(prim('A'))], { align: 'stretch' });
		const grid = container('g', 'grid', [c0, leaf(prim('L1'))], { cols: 2 });
		const root = container('root', 'col', [grid], { align: 'stretch' });
		const solved = new Map<string, Rect>([
			['root', { x: 0, y: 0, w: 200, h: 100 }],
			['g', { x: 0, y: 0, w: 200, h: 100 }],
			['A', { x: 0, y: 0, w: 100, h: 100 }],
			['L1', { x: 100, y: 0, w: 100, h: 100 }]
		]);
		// Interior of L1's cell, but cell drops are off → before/after the leaf instead.
		expect(dropTarget(root, solved, { x: 150, y: 50 }, 'W', false)).toEqual({
			parentId: 'g',
			index: 2
		});
	});

	it('never merges a dragged node with its own grid cell', () => {
		const grid = container('g', 'grid', [leaf(prim('L0'))], { cols: 1 });
		const root = container('root', 'col', [grid], { align: 'stretch' });
		const solved = new Map<string, Rect>([
			['root', { x: 0, y: 0, w: 100, h: 100 }],
			['g', { x: 0, y: 0, w: 100, h: 100 }]
		]);
		// Interior of L0's own cell while dragging L0 → falls through to "into the grid".
		expect(dropTarget(root, solved, { x: 50, y: 50 }, 'L0')).toEqual({ parentId: 'g', index: 0 });
	});

	it('prefers the first-found grid cell when two same-depth grids overlap the point', () => {
		const g1 = container('g1', 'grid', [leaf(prim('L1'))], { cols: 1 });
		const g2 = container('g2', 'grid', [leaf(prim('L2'))], { cols: 1 });
		const root = container('root', 'row', [g1, g2]);
		// Overlapping boxes (stale mid-drag measurements) — the later same-depth hit must not win.
		const solved = new Map<string, Rect>([
			['root', { x: 0, y: 0, w: 100, h: 100 }],
			['g1', { x: 0, y: 0, w: 100, h: 100 }],
			['g2', { x: 0, y: 0, w: 100, h: 100 }]
		]);
		expect(dropTarget(root, solved, { x: 50, y: 50 }, 'W')).toEqual({
			parentId: 'g1',
			index: 0,
			merge: 'L1'
		});
	});

	it('ignores a grid not yet measured when looking for cell drops', () => {
		const grid = container('g', 'grid', [leaf(prim('L0'))], { cols: 1 });
		const root = container('root', 'col', [grid]);
		// No 'g' box → no cell/merge drop; the leaf pass takes over (before L0's left half).
		const solved = new Map<string, Rect>([['L0', { x: 0, y: 0, w: 100, h: 100 }]]);
		expect(dropTarget(root, solved, { x: 10, y: 50 }, 'W')).toEqual({ parentId: 'g', index: 0 });
	});
});
