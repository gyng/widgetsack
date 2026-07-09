// Behavior tests for the "place" subset of editorOps: the helpers and tree-edit ops that put
// widgets/containers INTO the flow tree (or floating layer) and re-home existing nodes. Each op is
// pure and returns a Patch (Partial<EditorState>); we apply it via spread and assert the resulting
// tree shape / ids / basis / floating layer — never internals. Covers: lookup, currentContainer,
// wrapLeafWith, dropWidgetInto, reparentNode, replaceNodeOp, addWidget, addWidgetAt, addContainer,
// addBeside.
import { describe, expect, it } from 'vitest';
import {
	addBeside,
	addContainer,
	addWidget,
	addWidgetAt,
	currentContainer,
	dropWidgetInto,
	lookup,
	reparentNode,
	replaceNodeOp,
	wrapLeafWith
} from './editorOps';
import { createWidget } from '../../core/widget';
import {
	container,
	emptyMonitorLayout,
	isContainer,
	isLeaf,
	leaf,
	NEW_CONTAINER_GAP,
	type Container,
	type Leaf,
	type LayoutNode
} from '../../core/layoutTree';
import type { EditorState } from './types';

// --- fixtures -------------------------------------------------------------------------------

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
		historyReady: false,
		savedBaseline: null,
		pendingExtras: [],
		saveSeq: 0,
		studio: false
	};
}

const gauge = (id: string) => createWidget('gauge', id);

// A small tree:  root(col) > container1(row) > col1(col) > [ leaf w1, leaf w2 ]
function stateWithLayout(): {
	state: EditorState;
	rootId: string;
	containerId: string;
	col1Id: string;
} {
	const state = minimalState();
	const col1 = container('col1', 'col', [leaf(gauge('w1')), leaf(gauge('w2'))], {
		gap: 6,
		basis: { fr: 1 }
	});
	const containerNode = container('container1', 'row', [col1], { gap: 6, align: 'stretch' });
	const root = container('root', 'col', [containerNode], { align: 'stretch', pad: 16 });
	state.monitor.root = root;
	state.selectedId = 'w1';
	return { state, rootId: root.id, containerId: containerNode.id, col1Id: col1.id };
}

// =============================================================================================
// lookup
// =============================================================================================

describe('lookup', () => {
	it('finds a node deep in the flow tree by id', () => {
		const { state } = stateWithLayout();
		const node = lookup('w2', state.monitor);
		expect(node).not.toBeNull();
		expect(node?.id).toBe('w2');
		expect(node && isLeaf(node)).toBe(true);
	});

	it('finds a container (including the root)', () => {
		const { state } = stateWithLayout();
		const col1 = lookup('col1', state.monitor);
		expect(col1?.id).toBe('col1');
		expect(col1 && isContainer(col1)).toBe(true);
		expect(lookup('root', state.monitor)?.id).toBe('root');
	});

	it('finds a leaf in the floating layer when it is not in the tree', () => {
		const state = minimalState();
		state.monitor.floating = [leaf(gauge('float-1'))];
		const node = lookup('float-1', state.monitor);
		expect(node).not.toBeNull();
		expect(node?.id).toBe('float-1');
		expect(node && isLeaf(node)).toBe(true);
	});

	it('returns null for an unknown id', () => {
		const { state } = stateWithLayout();
		expect(lookup('nope', state.monitor)).toBeNull();
	});
});

// =============================================================================================
// currentContainer
// =============================================================================================

describe('currentContainer', () => {
	it('returns the selected node when it is a container', () => {
		const { state } = stateWithLayout();
		state.selectedId = 'col1';
		const cont = currentContainer(state);
		expect(cont).not.toBeNull();
		expect(cont?.id).toBe('col1');
		expect(cont?.kind).toBe('col');
	});

	it('returns null when the selected node is a leaf (widget), not a container', () => {
		const { state } = stateWithLayout();
		state.selectedId = 'w1';
		expect(currentContainer(state)).toBeNull();
	});

	it('returns null when nothing is selected', () => {
		const { state } = stateWithLayout();
		state.selectedId = null;
		expect(currentContainer(state)).toBeNull();
	});

	it('returns null when the selected id no longer exists', () => {
		const { state } = stateWithLayout();
		state.selectedId = 'ghost';
		expect(currentContainer(state)).toBeNull();
	});
});

// =============================================================================================
// wrapLeafWith
// =============================================================================================

describe('wrapLeafWith', () => {
	// The production merge-drop wraps a DISTINCT incoming node into the target's slot: it FIRST prunes
	// `removeId` from wherever it sits, then wraps `targetId` + the incoming node in a fresh cell.
	it('prunes the donor node (removeId) from its old slot', () => {
		const { state, col1Id } = stateWithLayout();
		const incoming = leaf(gauge('incoming'));
		// targetId absent → the updateNode pass is a no-op; only the prune of removeId (w2) is observable.
		const root = wrapLeafWith(state.monitor.root, 'absent-target', 'w2', incoming);

		expect(countOccurrences(root, 'w2')).toBe(0);
		expect((findNode2(root, col1Id) as Container).children.map((c) => c.id)).toEqual(['w1']);
	});

	it('wraps a PRESENT target + the incoming node into a fresh cell, without recursing', () => {
		// Merge-drop shape. Regression: this used to recurse unboundedly (rebuild re-descended into the
		// fresh wrapper, which still held the same-id target) — see the fix in core/layoutEdit.ts.
		const { state, col1Id } = stateWithLayout();
		const incoming = leaf(gauge('incoming'));
		const root = wrapLeafWith(state.monitor.root, 'w1', 'absent-donor', incoming);

		const col1 = findNode2(root, col1Id) as Container;
		expect(col1.children).toHaveLength(2);
		expect(col1.children[1].id).toBe('w2'); // sibling untouched
		const wrapper = col1.children[0] as Container;
		expect(isContainer(wrapper)).toBe(true);
		expect(wrapper.id).toMatch(/^cell-/);
		expect(wrapper.children.map((c) => c.id)).toEqual(['w1', 'incoming']);
		expect(countOccurrences(root, 'w1')).toBe(1); // not re-wrapped (recursion fixed)
	});

	it('leaves the tree shape intact (no new wrapper cell) when the target id is absent', () => {
		const { state } = stateWithLayout();
		const incoming = leaf(gauge('incoming'));
		const root = wrapLeafWith(state.monitor.root, 'absent-target', 'absent-donor', incoming);

		// No prune (donor absent) + no wrap (target absent) ⇒ same shape, no cell-* container appears.
		expect(allContainerIds(root)).toEqual(['root', 'container1', 'col1']);
		expect(countOccurrences(root, 'w1')).toBe(1);
		expect(countOccurrences(root, 'w2')).toBe(1);
	});
});

// =============================================================================================
// dropWidgetInto
// =============================================================================================

describe('dropWidgetInto', () => {
	it('appends a fresh widget of the given type into the target container and selects it', () => {
		const { state, col1Id } = stateWithLayout();
		const patch = dropWidgetInto(state, col1Id, 'text');
		const next = { ...state, ...patch };

		const col1 = lookup(col1Id, next.monitor) as Container;
		expect(col1.children).toHaveLength(3);
		const added = col1.children[2];
		expect(isLeaf(added)).toBe(true);
		expect((added as Leaf).id).toBe(patch.selectedId);
		expect(patch.selectedId).toMatch(/^text-/);
		expect(((added as Leaf).unit as { type: string }).type).toBe('text');
	});

	it('does not mutate the input state', () => {
		const { state, col1Id } = stateWithLayout();
		dropWidgetInto(state, col1Id, 'gauge');
		expect((lookup(col1Id, state.monitor) as Container).children).toHaveLength(2);
	});

	it('is a no-op on the tree when the target container id is unknown (still selects the new id)', () => {
		const { state } = stateWithLayout();
		const before = countLeaves(state.monitor.root);
		const patch = dropWidgetInto(state, 'nope', 'gauge');
		const next = { ...state, ...patch };
		// insertChild on a missing id leaves the tree unchanged, so no leaf was actually added.
		expect(countLeaves(next.monitor.root)).toBe(before);
		expect(patch.selectedId).toMatch(/^gauge-/);
	});
});

// =============================================================================================
// reparentNode
// =============================================================================================

describe('reparentNode', () => {
	it('moves a flow leaf into another container', () => {
		const { state, col1Id } = stateWithLayout();
		// Add a second empty container to move into.
		const withTarget = {
			...state,
			monitor: {
				...state.monitor,
				root: container('root', 'col', [
					state.monitor.root.children[0],
					container('bay', 'col', [], { align: 'stretch' })
				])
			}
		};
		const patch = reparentNode(withTarget, 'w2', 'bay');
		const next = { ...withTarget, ...patch };

		expect((lookup(col1Id, next.monitor) as Container).children.map((c) => c.id)).toEqual(['w1']);
		expect((lookup('bay', next.monitor) as Container).children.map((c) => c.id)).toEqual(['w2']);
		expect(patch.selectedId).toBe('w2');
	});

	it('docks a floating leaf into a flow container (removes it from floating)', () => {
		const { state, col1Id } = stateWithLayout();
		state.monitor.floating = [leaf(gauge('fl'))];
		const patch = reparentNode(state, 'fl', col1Id);
		const next = { ...state, ...patch };

		expect(next.monitor.floating).toHaveLength(0);
		expect((lookup(col1Id, next.monitor) as Container).children.map((c) => c.id)).toEqual([
			'w1',
			'w2',
			'fl'
		]);
		expect(patch.selectedId).toBe('fl');
	});

	it('is a no-op when reparenting a node into itself', () => {
		const { state } = stateWithLayout();
		expect(reparentNode(state, 'col1', 'col1')).toEqual({});
	});

	it('is a no-op when the target container is inside the moved subtree (would form a cycle)', () => {
		const { state } = stateWithLayout();
		// container1 contains col1 — moving container1 INTO col1 would be a cycle.
		expect(reparentNode(state, 'container1', 'col1')).toEqual({});
	});
});

// =============================================================================================
// replaceNodeOp
// =============================================================================================

describe('replaceNodeOp', () => {
	it('swaps a flow node wholesale and keeps selection on that id', () => {
		const { state } = stateWithLayout();
		const replacement = leaf(gauge('w1')); // same id, fresh unit (Inspector coerces the id)
		const patch = replaceNodeOp(state, 'w1', replacement);
		const next = { ...state, ...patch };

		const node = lookup('w1', next.monitor) as Leaf;
		expect(node).not.toBeNull();
		expect(node).toBe(replacement);
		expect(patch.selectedId).toBe('w1');
	});

	it('can replace a leaf with a container of the same id', () => {
		const { state } = stateWithLayout();
		const replacement = container('w2', 'row', [], { align: 'stretch' });
		const next = { ...state, ...replaceNodeOp(state, 'w2', replacement) };
		const node = lookup('w2', next.monitor);
		expect(node).not.toBeNull();
		expect(node && isContainer(node)).toBe(true);
		expect((node as Container).kind).toBe('row');
	});

	it('swaps a floating leaf in the floating array, not the tree', () => {
		const state = minimalState();
		state.monitor.floating = [leaf(gauge('fl'))];
		const replacement = leaf(gauge('fl'));
		const patch = replaceNodeOp(state, 'fl', replacement);
		const next = { ...state, ...patch };

		expect(next.monitor.floating).toHaveLength(1);
		expect(next.monitor.floating[0]).toBe(replacement);
		expect(patch.selectedId).toBe('fl');
	});

	it('leaves other floating leaves untouched when swapping one', () => {
		const state = minimalState();
		const bystander = leaf(gauge('other'));
		state.monitor.floating = [leaf(gauge('fl')), bystander];
		const replacement = leaf(gauge('fl'));
		const next = { ...state, ...replaceNodeOp(state, 'fl', replacement) };

		expect(next.monitor.floating[0]).toBe(replacement);
		expect(next.monitor.floating[1]).toBe(bystander); // passed through by reference
	});
});

// =============================================================================================
// addWidget
// =============================================================================================

describe('addWidget', () => {
	it('inserts the widget into the selected container when one is selected', () => {
		const { state, col1Id } = stateWithLayout();
		state.selectedId = col1Id;
		const patch = addWidget(state, 'gauge');
		const next = { ...state, ...patch };

		const col1 = lookup(col1Id, next.monitor) as Container;
		expect(col1.children).toHaveLength(3);
		expect(col1.children[2].id).toBe(patch.selectedId);
		expect(patch.selectedId).toMatch(/^gauge-/);
		// nothing went to the floating layer
		expect(next.monitor.floating).toHaveLength(0);
	});

	it('falls back to the floating layer when no container is selected', () => {
		const s = minimalState();
		s.selectedId = null;
		const patch = addWidget(s, 'gauge');
		const next = { ...s, ...patch };

		expect(next.monitor.floating).toHaveLength(1);
		expect(next.monitor.floating[0].id).toBe(patch.selectedId);
		// the flow tree is untouched
		expect(next.monitor.root.children).toHaveLength(0);
	});

	it('floats the widget when a LEAF is selected (a leaf is not a container)', () => {
		const { state } = stateWithLayout();
		state.selectedId = 'w1';
		const next = { ...state, ...addWidget(state, 'gauge') };
		expect(next.monitor.floating).toHaveLength(1);
	});
});

// =============================================================================================
// addWidgetAt
// =============================================================================================

describe('addWidgetAt', () => {
	it('creates a floating widget centered + grid-snapped on the drop point', () => {
		const s = minimalState();
		// gauge default size is 110x110. dropPlacement snaps (x - w/2) to the 8px grid.
		const patch = addWidgetAt(s, 'gauge', 200, 300);
		const next = { ...s, ...patch };

		expect(next.monitor.floating).toHaveLength(1);
		const fl = next.monitor.floating[0];
		expect(isLeaf(fl)).toBe(true);
		const rect = (fl.unit as { rect: { x: number; y: number } }).rect;
		// round((200 - 55) / 8) * 8 = round(18.125) * 8 = 144 ; round((300 - 55)/8)*8 = round(30.625)*8 = 248
		expect(rect.x).toBe(144);
		expect(rect.y).toBe(248);
		expect(patch.selectedId).toBe(fl.id);
	});

	it('does not touch the flow tree', () => {
		const { state } = stateWithLayout();
		const before = countLeaves(state.monitor.root);
		const next = { ...state, ...addWidgetAt(state, 'gauge', 0, 0) };
		expect(countLeaves(next.monitor.root)).toBe(before);
		expect(next.monitor.floating).toHaveLength(1);
	});
});

// =============================================================================================
// addContainer
// =============================================================================================

describe('addContainer', () => {
	it('appends a new col with the default gap + fr basis into the explicit target', () => {
		const { state, rootId } = stateWithLayout();
		const patch = addContainer(state, 'col', rootId);
		const next = { ...state, ...patch };

		const root = next.monitor.root;
		expect(root.children).toHaveLength(2);
		const added = root.children[1] as Container;
		expect(added.id).toBe(patch.selectedId);
		expect(added.kind).toBe('col');
		expect(added.gap).toBe(NEW_CONTAINER_GAP);
		expect(added.basis).toEqual({ fr: 1 });
		// the target gets align:'stretch'
		expect(root.align).toBe('stretch');
	});

	it('builds a 2x2 grid of col cells when kind is grid', () => {
		const { state, rootId } = stateWithLayout();
		const next = { ...state, ...addContainer(state, 'grid', rootId) };
		const grid = next.monitor.root.children[1] as Container;
		expect(grid.kind).toBe('grid');
		expect(grid.cols).toBe(2);
		expect(grid.rows).toBe(2);
		expect(grid.children).toHaveLength(4);
		expect(grid.children.every((c) => isContainer(c) && (c as Container).kind === 'col')).toBe(
			true
		);
	});

	it('targets the selected container when no containerId is given', () => {
		const { state, col1Id } = stateWithLayout();
		state.selectedId = col1Id;
		const next = { ...state, ...addContainer(state, 'row') };
		const col1 = lookup(col1Id, next.monitor) as Container;
		// w1, w2, + the new row
		expect(col1.children).toHaveLength(3);
		expect((col1.children[2] as Container).kind).toBe('row');
	});

	it('is a no-op when the target id is not a container', () => {
		const { state } = stateWithLayout();
		expect(addContainer(state, 'col', 'w1')).toEqual({});
	});

	it('pads earlier empty grid cells so the band lands in the clicked cell (index past child count)', () => {
		const { state } = stateWithLayout();
		// An empty grid with zero children; ask to insert the new col at index 2.
		const withGrid = {
			...state,
			monitor: {
				...state.monitor,
				root: container('root', 'col', [container('g', 'grid', [], { cols: 2, rows: 2 })], {
					align: 'stretch'
				})
			}
		};
		const next = { ...withGrid, ...addContainer(withGrid, 'col', 'g', 2) };
		const grid = lookup('g', next.monitor) as Container;
		// 2 spacer cells padded in (indices 0,1) + the new col at index 2 = 3 children.
		expect(grid.children).toHaveLength(3);
		expect(grid.children[2].id).toBe((next as EditorState).selectedId);
	});
});

// =============================================================================================
// addBeside
// =============================================================================================

describe('addBeside', () => {
	it('inserts a sibling of the given kind directly after the target in its parent', () => {
		const { state, containerId } = stateWithLayout();
		const patch = addBeside(state, 'col1', 'row');
		const next = { ...state, ...patch };

		const parent = lookup(containerId, next.monitor) as Container;
		expect(parent.children.map((c) => c.id)[0]).toBe('col1');
		const inserted = parent.children[1] as Container;
		expect(inserted.id).toBe(patch.selectedId);
		expect(inserted.kind).toBe('row');
		expect(inserted.gap).toBe(NEW_CONTAINER_GAP);
		// the parent is stretched so the new band fills the cross axis
		expect(parent.align).toBe('stretch');
	});

	it('is a no-op at the root (the root has no siblings)', () => {
		const { state } = stateWithLayout();
		expect(addBeside(state, 'root', 'row')).toEqual({});
	});

	it('is a no-op when the target id is not in the tree', () => {
		const { state } = stateWithLayout();
		expect(addBeside(state, 'does-not-exist', 'col')).toEqual({});
	});

	it('builds a 2x2 grid when kind is grid', () => {
		const { state } = stateWithLayout();
		const next = { ...state, ...addBeside(state, 'col1', 'grid') };
		const parent = lookup('container1', next.monitor) as Container;
		const grid = parent.children[1] as Container;
		expect(grid.kind).toBe('grid');
		expect(grid.cols).toBe(2);
		expect(grid.children).toHaveLength(4);
	});
});

// --- tiny tree helpers (test-local; assert on shape, not editorOps internals) ----------------

function findNode2(root: Container, id: string): LayoutNode | null {
	if (root.id === id) return root;
	for (const c of root.children) {
		if (isContainer(c)) {
			const hit = findNode2(c, id);
			if (hit) return hit;
		} else if (c.id === id) return c;
	}
	return null;
}

function allContainerIds(root: Container): string[] {
	const out = [root.id];
	for (const c of root.children) if (isContainer(c)) out.push(...allContainerIds(c));
	return out;
}

function countOccurrences(root: Container, id: string): number {
	let n = root.id === id ? 1 : 0;
	for (const c of root.children) {
		if (isContainer(c)) n += countOccurrences(c, id);
		else if (c.id === id) n += 1;
	}
	return n;
}

function countLeaves(root: Container): number {
	let n = 0;
	for (const c of root.children) {
		if (isContainer(c)) n += countLeaves(c);
		else n += 1;
	}
	return n;
}
