// Behavior tests for editorOps sizing / placement / float-dock ops. These ops are PURE — each
// returns a Patch (Partial<EditorState>) describing the change and NEVER mutates the input state.
// We assert on the resulting tree shape / floating layer / ids, not on internals. Covers:
//   patchContainerOp, setNodeBasis, setNodeBases, distributeEvenly, setGridTracks,
//   setLeafAlign, setLeafBox, floatingLeafFrom, dock, floatNode.
import { describe, expect, it } from 'vitest';
import {
	patchContainerOp,
	setNodeBasis,
	setNodeBases,
	distributeEvenly,
	setGridTracks,
	setLeafAlign,
	setLeafBox,
	floatingLeafFrom,
	dock,
	floatNode,
	setSolvedForFloat,
	lookup
} from './editorOps';
import { createWidget } from '../../core/widget';
import {
	container,
	leaf,
	group,
	isContainer,
	isGroup,
	isLeaf,
	emptyMonitorLayout,
	emptyRoot,
	type Container,
	type Leaf,
	type MonitorLayout
} from '../../core/layoutTree';
import type { Solved } from '../../core/solve';
import type { EditorState } from './types';

// --- fixtures --------------------------------------------------------------------------------

function minimalState(): EditorState {
	return {
		monitor: emptyMonitorLayout(),
		library: undefined,
		selectedId: null,
		selectedIds: [],
		lastPrimary: null,
		selectedTheme: '',
		themeLock: true,
		tokenOverrides: {},
		editingDefId: null,
		savedMonitor: null,
		defEditBaseline: null,
		previewDef: null,
		undoStack: [],
		redoStack: [],
		lastSnap: null,
		historyReady: true,
		savedBaseline: null,
		pendingExtras: [],
		saveSeq: 0,
		studio: true
	};
}

function gauge(id: string) {
	return createWidget('gauge', id);
}

// A row container ('container1') holding a col ('col1') with two gauge leaves (w1, w2).
function stateWithLayout(): { state: EditorState; rootId: string; col1Id: string } {
	const col1 = container('col1', 'col', [leaf(gauge('w1')), leaf(gauge('w2'))], {
		gap: 6,
		basis: { fr: 1 }
	});
	const containerNode = container('container1', 'row', [col1], { gap: 6, align: 'stretch' });
	const root = emptyRoot();
	root.children = [containerNode];

	const state = minimalState();
	state.monitor.root = root;
	state.selectedId = 'w1';

	return { state, rootId: root.id, col1Id: col1.id };
}

// A 2x2 grid 'g' with four 'col' cells, parented under root.
function stateWithGrid(): { state: EditorState; grid: Container } {
	const cells = ['c0', 'c1', 'c2', 'c3'].map((id) =>
		container(id, 'col', [], { align: 'stretch' })
	);
	const grid = container('g', 'grid', cells, { cols: 2, rows: 2, gap: 6 });
	const root = emptyRoot();
	root.children = [grid];
	const state = minimalState();
	state.monitor.root = root;
	return { state, grid };
}

const rootOf = (patch: Partial<EditorState>): Container => (patch.monitor as MonitorLayout).root;
const find = (root: Container, id: string): Container => {
	const hit = root.children.find((n): n is Container => isContainer(n) && n.id === id);
	if (!hit) throw new Error(`no container ${id}`);
	return hit;
};

// =============================================================================================
// patchContainerOp
// =============================================================================================

describe('patchContainerOp', () => {
	it('merges the patch onto the targeted container', () => {
		const { state, col1Id } = stateWithLayout();
		const patch = patchContainerOp(state, col1Id, { gap: 24, justify: 'center' });
		const col1 = find(find(rootOf(patch), 'container1'), col1Id);
		expect(col1.gap).toBe(24);
		expect(col1.justify).toBe('center');
		// untouched fields survive
		expect(col1.basis).toEqual({ fr: 1 });
	});

	it('does not mutate the input state', () => {
		const { state, col1Id } = stateWithLayout();
		patchContainerOp(state, col1Id, { gap: 99 });
		const orig = find(find(state.monitor.root, 'container1'), col1Id);
		expect(orig.gap).toBe(6);
	});

	it('trims grid children when cols/rows shrink below the cell count', () => {
		const { state } = stateWithGrid(); // 2x2 = cap 4, has 4 children
		const patch = patchContainerOp(state, 'g', { cols: 1, rows: 2 }); // cap 2
		const grid = find(rootOf(patch), 'g');
		expect(grid.cols).toBe(1);
		expect(grid.rows).toBe(2);
		expect(grid.children).toHaveLength(2); // dropped from the END (row-major)
		expect(grid.children.map((c) => c.id)).toEqual(['c0', 'c1']);
	});

	it('keeps all grid children when the new capacity still holds them', () => {
		const { state } = stateWithGrid();
		const patch = patchContainerOp(state, 'g', { cols: 3, rows: 2 }); // cap 6 >= 4
		const grid = find(rootOf(patch), 'g');
		expect(grid.children).toHaveLength(4);
	});

	it('does not trim a non-grid container even when given cols', () => {
		const { state, col1Id } = stateWithLayout(); // col1 has 2 leaves
		const patch = patchContainerOp(state, col1Id, { cols: 1 });
		const col1 = find(find(rootOf(patch), 'container1'), col1Id);
		expect(col1.children).toHaveLength(2);
	});
});

// =============================================================================================
// setNodeBasis
// =============================================================================================

describe('setNodeBasis', () => {
	it('sets a fr basis on a flow leaf', () => {
		const { state } = stateWithLayout();
		const patch = setNodeBasis(state, 'w1', { fr: 2 });
		const col1 = find(find(rootOf(patch), 'container1'), 'col1');
		const w1 = col1.children.find((n) => n.id === 'w1') as Leaf;
		expect(w1.basis).toEqual({ fr: 2 });
	});

	it('sets a fixed px basis on a container', () => {
		const { state, col1Id } = stateWithLayout();
		const patch = setNodeBasis(state, col1Id, 200);
		const col1 = find(find(rootOf(patch), 'container1'), col1Id);
		expect(col1.basis).toBe(200);
	});

	it('clears the basis when given undefined (back to auto)', () => {
		const { state, col1Id } = stateWithLayout(); // col1 starts with basis fr:1
		const patch = setNodeBasis(state, col1Id, undefined);
		const col1 = find(find(rootOf(patch), 'container1'), col1Id);
		expect('basis' in col1).toBe(false);
	});

	it('is a no-op (unchanged tree) for an unknown id', () => {
		const { state } = stateWithLayout();
		const patch = setNodeBasis(state, 'nope', { fr: 5 });
		// nothing changed: w1/w2 keep their (absent) basis
		const col1 = find(find(rootOf(patch), 'container1'), 'col1');
		const w1 = col1.children.find((n) => n.id === 'w1') as Leaf;
		expect('basis' in w1).toBe(false);
	});
});

// =============================================================================================
// setNodeBases
// =============================================================================================

describe('setNodeBases', () => {
	it('sets multiple node bases in one pass', () => {
		const { state } = stateWithLayout();
		const patch = setNodeBases(state, [
			{ id: 'w1', basis: { fr: 3 } },
			{ id: 'w2', basis: 50 }
		]);
		const col1 = find(find(rootOf(patch), 'container1'), 'col1');
		const w1 = col1.children.find((n) => n.id === 'w1') as Leaf;
		const w2 = col1.children.find((n) => n.id === 'w2') as Leaf;
		expect(w1.basis).toEqual({ fr: 3 });
		expect(w2.basis).toBe(50);
	});

	it('skips unknown ids and applies the known ones', () => {
		const { state } = stateWithLayout();
		const patch = setNodeBases(state, [
			{ id: 'ghost', basis: { fr: 9 } },
			{ id: 'w2', basis: { fr: 2 } }
		]);
		const col1 = find(find(rootOf(patch), 'container1'), 'col1');
		const w2 = col1.children.find((n) => n.id === 'w2') as Leaf;
		expect(w2.basis).toEqual({ fr: 2 });
	});

	it('returns the same monitor root reference behavior with an empty entry list', () => {
		const { state } = stateWithLayout();
		const patch = setNodeBases(state, []);
		// no entries → root passes through unchanged in shape
		expect(rootOf(patch).children).toHaveLength(1);
	});
});

// =============================================================================================
// distributeEvenly
// =============================================================================================

describe('distributeEvenly', () => {
	it('sets every child of a row/col to fr:1', () => {
		// col1 children start with no basis; set one to a fixed px first, then distribute.
		const { state, col1Id } = stateWithLayout();
		const pre = setNodeBasis(state, 'w1', 300);
		const s2 = { ...state, ...pre };
		const patch = distributeEvenly(s2, col1Id);
		const col1 = find(find(rootOf(patch), 'container1'), col1Id);
		for (const c of col1.children) {
			expect((c as Leaf).basis).toEqual({ fr: 1 });
		}
	});

	it('clears colFr/rowFr weights on a grid (reset to uniform)', () => {
		const { state } = stateWithGrid();
		// seed track weights, then distribute should drop them
		const seeded = setGridTracks(state, 'g', 'col', [{ index: 0, fr: 3 }]);
		const s2 = { ...state, ...seeded };
		const seededGrid = find(s2.monitor.root, 'g');
		expect(seededGrid.colFr).toBeDefined();

		const patch = distributeEvenly(s2, 'g');
		const grid = find(rootOf(patch), 'g');
		expect(grid.colFr).toBeUndefined();
		expect(grid.rowFr).toBeUndefined();
	});

	it('is a no-op for an empty container', () => {
		const empty = container('empty', 'col', []);
		const state = minimalState();
		state.monitor.root = container('root', 'col', [empty], { align: 'stretch' });
		expect(distributeEvenly(state, 'empty')).toEqual({});
	});

	it('is a no-op for an unknown id', () => {
		const { state } = stateWithLayout();
		expect(distributeEvenly(state, 'missing')).toEqual({});
	});

	it('is a no-op when the id is a leaf, not a container', () => {
		const { state } = stateWithLayout();
		expect(distributeEvenly(state, 'w1')).toEqual({});
	});
});

// =============================================================================================
// setGridTracks
// =============================================================================================

describe('setGridTracks', () => {
	it('writes col weights, defaulting absent tracks to 1', () => {
		const { state } = stateWithGrid(); // cols:2
		const patch = setGridTracks(state, 'g', 'col', [{ index: 1, fr: 2.5 }]);
		const grid = find(rootOf(patch), 'g');
		expect(grid.colFr).toEqual([1, 2.5]); // index 0 defaults to 1
	});

	it('writes row weights to rowFr', () => {
		const { state } = stateWithGrid(); // rows:2
		const patch = setGridTracks(state, 'g', 'row', [{ index: 0, fr: 4 }]);
		const grid = find(rootOf(patch), 'g');
		expect(grid.rowFr).toEqual([4, 1]);
	});

	it('rounds fr to 3 decimal places', () => {
		const { state } = stateWithGrid();
		const patch = setGridTracks(state, 'g', 'col', [{ index: 0, fr: 1.23456 }]);
		const grid = find(rootOf(patch), 'g');
		expect(grid.colFr?.[0]).toBe(1.235);
	});

	it('grows the array to cover an index beyond the col hint', () => {
		const { state } = stateWithGrid(); // cols:2
		const patch = setGridTracks(state, 'g', 'col', [{ index: 3, fr: 5 }]);
		const grid = find(rootOf(patch), 'g');
		expect(grid.colFr).toHaveLength(4); // grown to maxIdx+1
		expect(grid.colFr).toEqual([1, 1, 1, 5]);
	});

	it('preserves existing positive weights for tracks not in the entries', () => {
		const { state } = stateWithGrid();
		const seeded = setGridTracks(state, 'g', 'col', [{ index: 0, fr: 3 }]);
		const s2 = { ...state, ...seeded };
		const patch = setGridTracks(s2, 'g', 'col', [{ index: 1, fr: 2 }]);
		const grid = find(rootOf(patch), 'g');
		expect(grid.colFr).toEqual([3, 2]); // index 0's prior weight kept
	});

	it('is a no-op when the id is not a grid', () => {
		const { state, col1Id } = stateWithLayout(); // col1 is a 'col', not a grid
		expect(setGridTracks(state, col1Id, 'col', [{ index: 0, fr: 2 }])).toEqual({});
	});

	it('is a no-op for an unknown id', () => {
		const { state } = stateWithGrid();
		expect(setGridTracks(state, 'nope', 'col', [{ index: 0, fr: 2 }])).toEqual({});
	});
});

// =============================================================================================
// setLeafAlign
// =============================================================================================

describe('setLeafAlign', () => {
	it('sets halign/valign on a leaf', () => {
		const { state } = stateWithLayout();
		const patch = setLeafAlign(state, 'w1', 'right', 'bottom');
		const col1 = find(find(rootOf(patch), 'container1'), 'col1');
		const w1 = col1.children.find((n) => n.id === 'w1') as Leaf;
		expect(w1.halign).toBe('right');
		expect(w1.valign).toBe('bottom');
	});

	it("clears halign/valign when set to 'fill' (the default)", () => {
		const { state } = stateWithLayout();
		// first pin both, then reset both to fill
		const pinned = setLeafAlign(state, 'w1', 'center', 'middle');
		const s2 = { ...state, ...pinned };
		const patch = setLeafAlign(s2, 'w1', 'fill', 'fill');
		const col1 = find(find(rootOf(patch), 'container1'), 'col1');
		const w1 = col1.children.find((n) => n.id === 'w1') as Leaf;
		expect('halign' in w1).toBe(false);
		expect('valign' in w1).toBe(false);
	});

	it('is a no-op on a container (only leaves carry halign/valign)', () => {
		const { state, col1Id } = stateWithLayout();
		const patch = setLeafAlign(state, col1Id, 'left', 'top');
		const col1 = find(find(rootOf(patch), 'container1'), col1Id);
		expect('halign' in col1).toBe(false);
		expect('valign' in col1).toBe(false);
	});

	it('can set just one axis while leaving the other at fill', () => {
		const { state } = stateWithLayout();
		const patch = setLeafAlign(state, 'w2', 'fill', 'top');
		const col1 = find(find(rootOf(patch), 'container1'), 'col1');
		const w2 = col1.children.find((n) => n.id === 'w2') as Leaf;
		expect('halign' in w2).toBe(false);
		expect(w2.valign).toBe('top');
	});
});

// =============================================================================================
// setLeafBox
// =============================================================================================

describe('setLeafBox', () => {
	it('sets a uniform margin on a leaf', () => {
		const { state } = stateWithLayout();
		const patch = setLeafBox(state, 'w1', 'margin', 8);
		const col1 = find(find(rootOf(patch), 'container1'), 'col1');
		const w1 = col1.children.find((n) => n.id === 'w1') as Leaf;
		expect(w1.margin).toBe(8);
	});

	it('sets per-side padding on a leaf', () => {
		const { state } = stateWithLayout();
		const pad = { t: 1, r: 2, b: 3, l: 4 };
		const patch = setLeafBox(state, 'w2', 'pad', pad);
		const col1 = find(find(rootOf(patch), 'container1'), 'col1');
		const w2 = col1.children.find((n) => n.id === 'w2') as Leaf;
		expect(w2.pad).toEqual(pad);
	});

	it('clears the field when value is undefined', () => {
		const { state } = stateWithLayout();
		const set = setLeafBox(state, 'w1', 'margin', 12);
		const s2 = { ...state, ...set };
		const patch = setLeafBox(s2, 'w1', 'margin', undefined);
		const col1 = find(find(rootOf(patch), 'container1'), 'col1');
		const w1 = col1.children.find((n) => n.id === 'w1') as Leaf;
		expect('margin' in w1).toBe(false);
	});

	it('is a no-op on a container', () => {
		const { state, col1Id } = stateWithLayout();
		const patch = setLeafBox(state, col1Id, 'pad', 10);
		const col1 = find(find(rootOf(patch), 'container1'), col1Id);
		// the container's own pad is untouched (it had none)
		expect('pad' in col1).toBe(false);
	});

	it('leaves margin untouched when setting pad and vice versa', () => {
		const { state } = stateWithLayout();
		const withMargin = setLeafBox(state, 'w1', 'margin', 5);
		const s2 = { ...state, ...withMargin };
		const patch = setLeafBox(s2, 'w1', 'pad', 7);
		const col1 = find(find(rootOf(patch), 'container1'), 'col1');
		const w1 = col1.children.find((n) => n.id === 'w1') as Leaf;
		expect(w1.margin).toBe(5);
		expect(w1.pad).toBe(7);
	});
});

// =============================================================================================
// floatingLeafFrom
// =============================================================================================

describe('floatingLeafFrom', () => {
	it('positions a primitive leaf at (x,y), preserving its size by default', () => {
		const src = gauge('w1');
		const node = leaf(src);
		const fl = floatingLeafFrom(node, 100, 200);
		expect(fl.id).toBe('w1');
		expect(isLeaf(fl)).toBe(true);
		expect(isGroup(fl.unit)).toBe(false);
		const u = fl.unit as ReturnType<typeof gauge>;
		expect(u.rect.x).toBe(100);
		expect(u.rect.y).toBe(200);
		// size carried over from the source rect (no rect arg given)
		expect(u.rect.w).toBe(src.rect.w);
		expect(u.rect.h).toBe(src.rect.h);
	});

	it('overrides w/h from the provided rect', () => {
		const node = leaf(gauge('w1'));
		const fl = floatingLeafFrom(node, 10, 20, { x: 0, y: 0, w: 333, h: 222 });
		const u = fl.unit as ReturnType<typeof gauge>;
		expect(u.rect).toEqual({ x: 10, y: 20, w: 333, h: 222 });
	});

	it('anchors a group leaf via config.x/config.y (not a rect)', () => {
		const g = group('grp-1', { w: 40, h: 40 }, leaf(gauge('inner')), { name: 'g' });
		const node = leaf(g);
		const fl = floatingLeafFrom(node, 70, 90);
		expect(isGroup(fl.unit)).toBe(true);
		const out = fl.unit as typeof g;
		expect(out.config?.x).toBe(70);
		expect(out.config?.y).toBe(90);
	});
});

// =============================================================================================
// dock (floating -> flow tree)
// =============================================================================================

describe('dock', () => {
	it('moves a floating leaf into the flow root and selects it', () => {
		const state = minimalState();
		const fl = floatingLeafFrom(leaf(gauge('f1')), 50, 60);
		state.monitor.floating = [fl];

		const patch = dock(state, 'f1');
		const mon = patch.monitor as MonitorLayout;
		expect(mon.floating).toHaveLength(0);
		expect(mon.root.children.map((c) => c.id)).toContain('f1');
		expect(patch.selectedId).toBe('f1');
	});

	it('is a no-op for an id not in the floating layer', () => {
		const { state } = stateWithLayout(); // w1 is in the flow tree, not floating
		expect(dock(state, 'w1')).toEqual({});
	});

	it('only removes the docked leaf, leaving other floaters in place', () => {
		const state = minimalState();
		state.monitor.floating = [
			floatingLeafFrom(leaf(gauge('f1')), 0, 0),
			floatingLeafFrom(leaf(gauge('f2')), 10, 10)
		];
		const patch = dock(state, 'f1');
		const mon = patch.monitor as MonitorLayout;
		expect(mon.floating.map((l) => l.id)).toEqual(['f2']);
	});
});

// =============================================================================================
// floatNode (flow tree -> floating)
// =============================================================================================

describe('floatNode', () => {
	it('moves a flow leaf to the floating layer using the solved rect', () => {
		setSolvedForFloat(new Map([['w1', { x: 12, y: 34, w: 100, h: 50 }]]) as Solved);
		const { state } = stateWithLayout();

		const patch = floatNode(state, 'w1');
		const mon = patch.monitor as MonitorLayout;
		// removed from the flow tree
		const col1 = find(find(mon.root, 'container1'), 'col1');
		expect(col1.children.map((c) => c.id)).toEqual(['w2']);
		// added to floating at the solved position/size
		expect(mon.floating).toHaveLength(1);
		const fl = mon.floating[0];
		expect(fl.id).toBe('w1');
		const u = fl.unit as ReturnType<typeof gauge>;
		expect(u.rect).toEqual({ x: 12, y: 34, w: 100, h: 50 });
		expect(patch.selectedId).toBe('w1');
	});

	it('honors an explicit `at` point over the solved rect position', () => {
		setSolvedForFloat(new Map([['w1', { x: 12, y: 34, w: 100, h: 50 }]]) as Solved);
		const { state } = stateWithLayout();
		const patch = floatNode(state, 'w1', { x: 500, y: 600 });
		const mon = patch.monitor as MonitorLayout;
		const u = mon.floating[0].unit as ReturnType<typeof gauge>;
		expect(u.rect.x).toBe(500);
		expect(u.rect.y).toBe(600);
		// size still from the solved rect
		expect(u.rect.w).toBe(100);
		expect(u.rect.h).toBe(50);
	});

	it('defaults to (0,0) when there is no solved rect and no `at`', () => {
		setSolvedForFloat(new Map() as Solved);
		const { state } = stateWithLayout();
		const patch = floatNode(state, 'w1');
		const mon = patch.monitor as MonitorLayout;
		const u = mon.floating[0].unit as ReturnType<typeof gauge>;
		expect(u.rect.x).toBe(0);
		expect(u.rect.y).toBe(0);
	});

	it('is a no-op for an unknown id', () => {
		setSolvedForFloat(new Map() as Solved);
		const { state } = stateWithLayout();
		expect(floatNode(state, 'ghost')).toEqual({});
	});

	it('is a no-op for a container id (only leaves float)', () => {
		setSolvedForFloat(new Map() as Solved);
		const { state, col1Id } = stateWithLayout();
		expect(floatNode(state, col1Id)).toEqual({});
	});

	it('the floated leaf is findable via lookup in the resulting monitor', () => {
		setSolvedForFloat(new Map([['w2', { x: 1, y: 2, w: 3, h: 4 }]]) as Solved);
		const { state } = stateWithLayout();
		const patch = floatNode(state, 'w2');
		const mon = patch.monitor as MonitorLayout;
		const found = lookup('w2', mon);
		expect(found).not.toBeNull();
		expect(isLeaf(found as Leaf)).toBe(true);
	});
});
