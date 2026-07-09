// Behavior tests for the structural editorOps: split / remove / reorder / indent / outdent /
// ungroup / makeWidget. Each op is PURE and returns a Patch (Partial<EditorState>) that we apply
// via spread — we assert on the resulting tree shape, ids, basis, the floating layer, and library
// defs, never on op internals. Covers the no-op / clamp / empty-selection branches too.
import { describe, expect, it } from 'vitest';
import {
	indent,
	makeWidget,
	outdent,
	removeById,
	reorder,
	splitNode,
	ungroupSelected
} from './editorOps';
import { createWidget } from '../../core/widget';
import {
	container,
	group,
	isContainer,
	isGroup,
	isLeaf,
	leaf,
	type Container
} from '../../core/layoutTree';
import type { EditorState } from './types';

// --- fixtures -------------------------------------------------------------------------------

function minimalState(root: Container): EditorState {
	return {
		monitor: { root, floating: [] },
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

const gauge = (id: string) => createWidget('gauge', id);

// Find a container child by id (throws so a wrong-tree assertion fails loudly).
function childContainer(c: Container, id: string): Container {
	const hit = c.children.find((n): n is Container => isContainer(n) && n.id === id);
	if (!hit) throw new Error(`no container child ${id}`);
	return hit;
}

describe('splitNode', () => {
	it('empty col → "rows" becomes a col holding two empty row bands', () => {
		const s = minimalState(container('root', 'col', []));
		const patch = splitNode(s, 'root', 'rows');
		const root = patch.monitor!.root;
		expect(root.kind).toBe('col'); // the stacker keeps the col kind
		const bands = root.children.filter(isContainer);
		expect(bands.map((b) => b.kind)).toEqual(['row', 'row']);
		// no existing content → the FIRST band is selected
		expect(patch.selectedId).toBe(root.children[0].id);
	});

	it('"cols" turns a col into a row of two col strips', () => {
		const s = minimalState(container('root', 'col', []));
		const root = splitNode(s, 'root', 'cols').monitor!.root;
		expect(root.kind).toBe('row');
		expect(root.children.filter(isContainer).map((b) => b.kind)).toEqual(['col', 'col']);
	});

	it('a populated node keeps its content in band 0 and adds ONE new band, selecting the new band', () => {
		const populated = container('root', 'col', [leaf(gauge('w1'))]);
		const s = minimalState(populated);
		const patch = splitNode(s, 'root', 'rows');
		const root = patch.monitor!.root;
		expect(root.children).toHaveLength(2);
		// band 0 wraps the existing content (a re-wrapped cell that still carries the widget)…
		const keep = root.children[0] as Container;
		expect(isContainer(keep)).toBe(true);
		expect(keep.children[0].id).toBe('w1');
		// …band 1 is a fresh empty band, and IT is the selection
		const fresh = root.children[1] as Container;
		expect(fresh.children).toHaveLength(0);
		expect(patch.selectedId).toBe(fresh.id);
	});

	it('"grid" produces a 2×2 grid (4 cells)', () => {
		const s = minimalState(container('root', 'col', []));
		const root = splitNode(s, 'root', 'grid').monitor!.root;
		expect(root.kind).toBe('grid');
		expect(root.cols).toBe(2);
		expect(root.rows).toBe(2);
		expect(root.children).toHaveLength(4);
	});

	it('"grid" on a populated node wraps the content into cell 0 and selects the last cell', () => {
		const s = minimalState(container('root', 'col', [leaf(gauge('w1'))]));
		const patch = splitNode(s, 'root', 'grid');
		const root = patch.monitor!.root;
		expect(root.kind).toBe('grid');
		expect(root.children).toHaveLength(4);
		const keep = root.children[0] as Container;
		expect(keep.children.map((c) => c.id)).toEqual(['w1']); // existing content kept in cell 0
		expect(patch.selectedId).toBe(root.children[3].id); // with content kept, the LAST cell is selected
	});

	it('is a no-op ({}) when the id is missing or is a leaf', () => {
		const s = minimalState(container('root', 'col', [leaf(gauge('w1'))]));
		expect(splitNode(s, 'nope', 'rows')).toEqual({});
		expect(splitNode(s, 'w1', 'rows')).toEqual({}); // a widget leaf is not a container
	});
});

describe('removeById', () => {
	it('removes a flow leaf from the tree', () => {
		const s = minimalState(container('root', 'col', [leaf(gauge('w1')), leaf(gauge('w2'))]));
		const patch = removeById(s, 'w1');
		const root = patch.monitor!.root;
		expect(root.children.map((c) => c.id)).toEqual(['w2']);
	});

	it('removes a leaf from the floating layer (tree untouched)', () => {
		const s = minimalState(container('root', 'col', [leaf(gauge('w1'))]));
		s.monitor.floating = [leaf(gauge('f1')), leaf(gauge('f2'))];
		const patch = removeById(s, 'f1');
		expect(patch.monitor!.floating.map((l) => l.id)).toEqual(['f2']);
		expect(patch.monitor!.root.children.map((c) => c.id)).toEqual(['w1']);
	});

	it('removing the PRIMARY selection clears both selectedId and the marquee set', () => {
		const s = minimalState(container('root', 'col', [leaf(gauge('w1')), leaf(gauge('w2'))]));
		s.selectedId = 'w1';
		s.selectedIds = ['w1', 'w2'];
		const patch = removeById(s, 'w1');
		expect(patch.selectedId).toBeNull();
		expect(patch.selectedIds).toEqual([]);
	});

	it('removing a NON-primary marquee member just filters it (primary kept)', () => {
		const s = minimalState(container('root', 'col', [leaf(gauge('w1')), leaf(gauge('w2'))]));
		s.selectedId = 'w1';
		s.selectedIds = ['w1', 'w2'];
		const patch = removeById(s, 'w2');
		expect(patch.selectedIds).toEqual(['w1']);
		expect(patch.selectedId).toBeUndefined(); // primary not touched in the patch
	});

	it('does not touch selection when the removed id was not selected', () => {
		const s = minimalState(container('root', 'col', [leaf(gauge('w1')), leaf(gauge('w2'))]));
		s.selectedId = 'w1';
		s.selectedIds = ['w1'];
		const patch = removeById(s, 'w2');
		expect(patch.selectedId).toBeUndefined();
		expect(patch.selectedIds).toBeUndefined();
		expect(patch.monitor!.root.children.map((c) => c.id)).toEqual(['w1']);
	});
});

describe('reorder', () => {
	const threeKids = () =>
		minimalState(container('root', 'col', [leaf(gauge('a')), leaf(gauge('b')), leaf(gauge('c'))]));

	it('moves a child forward by a positive delta', () => {
		const patch = reorder(threeKids(), 'a', 1);
		expect(patch.monitor!.root.children.map((c) => c.id)).toEqual(['b', 'a', 'c']);
	});

	it('moves a child backward by a negative delta', () => {
		const patch = reorder(threeKids(), 'c', -1);
		expect(patch.monitor!.root.children.map((c) => c.id)).toEqual(['a', 'c', 'b']);
	});

	it('clamps to a no-op past the start', () => {
		expect(reorder(threeKids(), 'a', -1)).toEqual({});
	});

	it('clamps to a no-op past the end', () => {
		expect(reorder(threeKids(), 'c', 1)).toEqual({});
	});

	it('is a no-op for a node with no parent (the root)', () => {
		expect(reorder(threeKids(), 'root', 1)).toEqual({});
	});
});

describe('indent', () => {
	it('nests a node into its previous sibling container', () => {
		// [colA(empty), w] → indenting w moves it into colA
		const s = minimalState(
			container('root', 'col', [container('colA', 'col', []), leaf(gauge('w'))])
		);
		const patch = indent(s, 'w');
		const root = patch.monitor!.root;
		expect(root.children.map((c) => c.id)).toEqual(['colA']); // w left the root level
		const colA = childContainer(root, 'colA');
		expect(colA.children.map((c) => c.id)).toEqual(['w']); // …and landed inside colA
	});

	it('is a no-op when the previous sibling is a leaf (not a container)', () => {
		const s = minimalState(container('root', 'col', [leaf(gauge('a')), leaf(gauge('b'))]));
		expect(indent(s, 'b')).toEqual({});
	});

	it('is a no-op when there is no previous sibling (first child)', () => {
		const s = minimalState(
			container('root', 'col', [leaf(gauge('a')), container('colB', 'col', [])])
		);
		expect(indent(s, 'a')).toEqual({});
	});

	it('is a no-op for the root or an unknown id (no parent to indent within)', () => {
		const s = minimalState(container('root', 'col', [leaf(gauge('a'))]));
		expect(indent(s, 'root')).toEqual({});
		expect(indent(s, 'missing')).toEqual({});
	});
});

describe('outdent', () => {
	it('lifts a node out to its grandparent, right after its old parent', () => {
		// root > colA > [w] ; outdent w → root > [colA, w]
		const s = minimalState(
			container('root', 'col', [container('colA', 'col', [leaf(gauge('w'))])])
		);
		const patch = outdent(s, 'w');
		const root = patch.monitor!.root;
		expect(root.children.map((c) => c.id)).toEqual(['colA', 'w']);
		expect(childContainer(root, 'colA').children).toHaveLength(0);
	});

	it('inserts the node directly after its parent among the grandparent siblings', () => {
		// root > [colA > [w], colB] ; outdent w → root > [colA, w, colB]
		const s = minimalState(
			container('root', 'col', [
				container('colA', 'col', [leaf(gauge('w'))]),
				container('colB', 'col', [])
			])
		);
		const root = outdent(s, 'w').monitor!.root;
		expect(root.children.map((c) => c.id)).toEqual(['colA', 'w', 'colB']);
	});

	it('is a no-op when the node sits directly under the root (parent IS root)', () => {
		const s = minimalState(container('root', 'col', [leaf(gauge('w'))]));
		expect(outdent(s, 'w')).toEqual({});
	});
});

describe('ungroupSelected', () => {
	it('replaces a flow group leaf with its inline child', () => {
		const inner = leaf(gauge('inner'));
		const g = group('grp1', { w: 120, h: 80 }, inner);
		const s = minimalState(container('root', 'col', [leaf(g)]));
		const patch = ungroupSelected(s, 'grp1');
		const root = patch.monitor!.root;
		// the group leaf is gone; its concrete child took its place
		expect(root.children).toHaveLength(1);
		const replaced = root.children[0];
		expect(isLeaf(replaced)).toBe(true);
		expect(replaced.id).toBe('inner');
		expect(isGroup((replaced as ReturnType<typeof leaf>).unit)).toBe(false);
		expect(patch.selectedId).toBeNull();
	});

	it('ungroups a FLOATING group: unwraps the child unit and carries the group anchor onto its rect', () => {
		const inner = leaf(gauge('inner'));
		const g = group('grpF', { w: 120, h: 80 }, inner, { config: { x: 30, y: 40 } });
		const s = minimalState(container('root', 'col', []));
		s.monitor.floating = [leaf(g)];
		const patch = ungroupSelected(s, 'grpF');
		const fl = patch.monitor!.floating;
		expect(fl).toHaveLength(1);
		const u = fl[0].unit;
		expect(isGroup(u)).toBe(false);
		// the unwrapped primitive inherits the group's floating anchor as its rect origin
		expect((u as ReturnType<typeof gauge>).rect.x).toBe(30);
		expect((u as ReturnType<typeof gauge>).rect.y).toBe(40);
		expect(patch.selectedId).toBe(u.id);
	});

	it('ungroups a floating def-backed group from the DEF child, leaving other floaters alone', () => {
		const s = minimalState(container('root', 'col', []));
		s.library = {
			version: 1,
			defs: [{ id: 'def-1', name: 'g', size: { w: 10, h: 10 }, child: leaf(gauge('def-inner')) }]
		};
		const g = group('grpF', { w: 10, h: 10 }, leaf(gauge('inline-inner')), {
			def: 'def-1',
			config: { x: 5, y: 6 }
		});
		const bystander = leaf(gauge('bystander'));
		s.monitor.floating = [leaf(g), bystander];
		const patch = ungroupSelected(s, 'grpF');
		const u = patch.monitor!.floating[0].unit as ReturnType<typeof gauge>;
		expect(u.id).toBe('def-inner'); // the def child wins over the inline child
		expect(u.rect.x).toBe(5);
		expect(u.rect.y).toBe(6);
		expect(patch.monitor!.floating[1]).toBe(bystander); // pass-through by reference
		expect(patch.selectedId).toBe('def-inner');
	});

	it('falls back to the inline child when the group names a def but no library is loaded', () => {
		const s = minimalState(container('root', 'col', []));
		const g = group('grpF', { w: 10, h: 10 }, leaf(gauge('inline-inner')), {
			def: 'def-gone',
			config: { x: 1, y: 2 }
		});
		s.monitor.floating = [leaf(g)];
		const patch = ungroupSelected(s, 'grpF');
		const u = patch.monitor!.floating[0].unit as ReturnType<typeof gauge>;
		expect(u.id).toBe('inline-inner');
		expect(u.rect.x).toBe(1);
	});

	it('is a no-op on a non-group floating leaf', () => {
		const s = minimalState(container('root', 'col', []));
		s.monitor.floating = [leaf(gauge('plain'))];
		expect(ungroupSelected(s, 'plain')).toEqual({});
	});

	it('is a no-op ({}) on a missing id', () => {
		const s = minimalState(container('root', 'col', [leaf(gauge('w1'))]));
		// a plain flow leaf isn't a group → ungroupNode returns the (unchanged) root, selection nulled
		const patch = ungroupSelected(s, 'nope');
		expect(patch.monitor!.root.children.map((c) => c.id)).toEqual(['w1']);
		expect(patch.selectedId).toBeNull();
	});
});

describe('makeWidget', () => {
	it('promotes a flow leaf into a group backed by a new library def', () => {
		const s = minimalState(container('root', 'col', [leaf(gauge('w1'))]));
		const patch = makeWidget(s, 'w1');
		// library gained exactly one def, named after the widget type
		expect(patch.library).toBeDefined();
		expect(patch.library!.defs).toHaveLength(1);
		const def = patch.library!.defs[0];
		expect(def.name).toBe('gauge');
		expect(def.id).toMatch(/^def-/);
		// the leaf at w1's slot is now a group leaf referencing that def
		const node = patch.monitor!.root.children[0];
		expect(isLeaf(node)).toBe(true);
		const unit = (node as ReturnType<typeof leaf>).unit;
		expect(isGroup(unit)).toBe(true);
		if (!isGroup(unit)) throw new Error('expected a group unit');
		expect(unit.def).toBe(def.id);
		// the new group is selected
		expect(patch.selectedId).toBe(unit.id);
		expect(patch.selectedId).toMatch(/^grp-/);
	});

	it('appends to an existing library rather than replacing it', () => {
		const s = minimalState(container('root', 'col', [leaf(gauge('w1'))]));
		s.library = {
			version: 1,
			defs: [{ id: 'def-keep', name: 'existing', size: { w: 10, h: 10 }, child: leaf(gauge('x')) }]
		};
		const patch = makeWidget(s, 'w1');
		expect(patch.library!.defs.map((d) => d.id)).toContain('def-keep');
		expect(patch.library!.defs).toHaveLength(2);
	});

	it('promotes a FLOATING primitive into a floating group preserving its x/y anchor', () => {
		const inst = gauge('f1');
		inst.rect = { ...inst.rect, x: 55, y: 66 };
		const s = minimalState(container('root', 'col', []));
		s.monitor.floating = [leaf(inst)];
		const patch = makeWidget(s, 'f1');
		const fl = patch.monitor!.floating;
		expect(fl).toHaveLength(1);
		const unit = fl[0].unit;
		expect(isGroup(unit)).toBe(true);
		if (!isGroup(unit)) throw new Error('expected a group unit');
		// the group keeps the floating anchor in its config
		expect(unit.config).toEqual({ x: 55, y: 66 });
		expect(patch.selectedId).toBe(unit.id);
	});

	it('promotes an empty CONTAINER with the fallback def size and a widget-<kind> name', () => {
		const s = minimalState(container('root', 'col', [container('band', 'row', [])]));
		const patch = makeWidget(s, 'band');
		const def = patch.library!.defs[0];
		expect(def.name).toBe('widget-row'); // containers are named after their kind
		expect(def.size).toEqual({ w: 120, h: 80 }); // intrinsic 0 → the || size fallbacks
		const unit = (patch.monitor!.root.children[0] as ReturnType<typeof leaf>).unit;
		expect(isGroup(unit)).toBe(true);
	});

	it('leaves other floaters untouched when promoting a floating primitive', () => {
		const s = minimalState(container('root', 'col', []));
		const bystander = leaf(gauge('bystander'));
		s.monitor.floating = [leaf(gauge('f1')), bystander];
		const patch = makeWidget(s, 'f1');
		expect(patch.monitor!.floating[1]).toBe(bystander); // pass-through by reference
	});

	it('is a no-op ({}) on a missing id', () => {
		const s = minimalState(container('root', 'col', [leaf(gauge('w1'))]));
		expect(makeWidget(s, 'nope')).toEqual({});
	});
});
