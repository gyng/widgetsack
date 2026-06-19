// Behavior tests for the def/library + small-utility editorOps: insertWidget, insertTemplate,
// defInUse, renameDef, deleteDef, cfgNum, clone, rand. These are PURE ops — each returns a Patch
// (Partial<EditorState>) the reducer applies via spread; they never mutate the input. We assert on
// the observable result (the patched tree shape, ids, library defs, the returned boolean/value),
// never on internals.
import { describe, expect, it } from 'vitest';
import {
	cfgNum,
	clone,
	defInUse,
	deleteDef,
	insertTemplate,
	insertWidget,
	rand,
	renameDef
} from './editorOps';
import {
	container,
	group,
	isContainer,
	isGroup,
	isLeaf,
	leaf,
	type Container,
	type Leaf,
	type Library,
	type MonitorLayout,
	type WidgetDef
} from '../../core/layoutTree';
import { getTemplate } from '../../core/templates';
import type { EditorState } from './types';

const CLOCK = 'clock-jp'; // a built-in template id

// A minimal valid EditorState with the few fields these ops read defaulted; `over` overrides.
function state(over: Partial<EditorState> = {}): EditorState {
	const monitor: MonitorLayout = { root: container('root', 'col', []), floating: [] };
	return {
		monitor,
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
		studio: true,
		...over
	};
}

// A WidgetDef with an inline child (what insertWidget clones an instance from).
function gaugeDef(id: string, name = 'gauge'): WidgetDef {
	return {
		id,
		name,
		size: { w: 100, h: 80 },
		child: container('def-inner', 'col', [], { align: 'stretch' })
	};
}

// A floating leaf that is a GROUP instance of `defId` (what defInUse scans for).
const instanceOf = (defId: string): Leaf =>
	leaf(group(`grp-${defId}`, { w: 10, h: 10 }, container('inner', 'col', []), { def: defId }));

describe('rand', () => {
	it('returns a 6-char base-36 suffix', () => {
		const r = rand();
		expect(typeof r).toBe('string');
		expect(r).toHaveLength(6);
		expect(r).toMatch(/^[0-9a-z]{6}$/);
	});

	it('is (practically) unique between calls', () => {
		const ids = new Set(Array.from({ length: 50 }, () => rand()));
		expect(ids.size).toBe(50);
	});
});

describe('clone', () => {
	it('deep-copies a value so mutating the copy leaves the original intact', () => {
		const original = { a: 1, nested: { list: [1, 2, 3] } };
		const copy = clone(original);

		expect(copy).toEqual(original);
		expect(copy).not.toBe(original); // a fresh top-level object
		expect(copy.nested).not.toBe(original.nested); // …and fresh nested objects

		copy.nested.list.push(4);
		copy.a = 99;
		expect(original.nested.list).toEqual([1, 2, 3]);
		expect(original.a).toBe(1);
	});

	it('round-trips a layout container tree by value', () => {
		const tree = container('c', 'row', [
			leaf({ id: 'w', type: 'gauge', rect: { x: 0, y: 0, w: 1, h: 1 }, config: {} })
		]);
		const copy = clone(tree);
		expect(copy).toEqual(tree);
		expect(copy.children[0]).not.toBe(tree.children[0]);
	});
});

describe('cfgNum', () => {
	it('returns the value when the key holds a number', () => {
		expect(cfgNum({ x: 42 }, 'x')).toBe(42);
		expect(cfgNum({ x: 0 }, 'x')).toBe(0);
		expect(cfgNum({ x: -12.5 }, 'x')).toBe(-12.5);
	});

	it('returns 0 for a missing key, non-number value, or undefined config', () => {
		expect(cfgNum({ x: 42 }, 'y')).toBe(0); // missing key
		expect(cfgNum({ x: '42' }, 'x')).toBe(0); // string, not number
		expect(cfgNum({ x: null }, 'x')).toBe(0); // null
		expect(cfgNum(undefined, 'x')).toBe(0); // no config at all
	});
});

describe('insertWidget', () => {
	it('docks a group instance of the def into the flow ROOT and selects it', () => {
		const library: Library = { version: 1, defs: [gaugeDef('def-1')] };
		const s = state({ library });

		const patch = insertWidget(s, 'def-1');

		// Input untouched (pure op).
		expect(s.monitor.root.children).toHaveLength(0);

		const next = { ...s, ...patch };
		expect(next.monitor.root.children).toHaveLength(1);
		const node = next.monitor.root.children[0];
		if (!isLeaf(node) || !isGroup(node.unit)) throw new Error('expected a group leaf');
		expect(node.unit.def).toBe('def-1');
		expect(node.unit.name).toBe('gauge');
		expect(node.unit.size).toEqual({ w: 100, h: 80 }); // copied from the def
		expect(node.id).toMatch(/^grp-/);
		expect(next.selectedId).toBe(node.id);
		// The leaf id mirrors its group unit id (leaf() invariant).
		expect(node.id).toBe(node.unit.id);
	});

	it('clones the def child (the group child is a copy, not a shared reference)', () => {
		const def = gaugeDef('def-1');
		const s = state({ library: { version: 1, defs: [def] } });

		const patch = insertWidget(s, 'def-1');
		const node = (patch.monitor as MonitorLayout).root.children[0] as Leaf;
		const grp = node.unit;
		if (!isGroup(grp)) throw new Error('expected a group');
		expect(grp.child).toEqual(def.child);
		expect(grp.child).not.toBe(def.child); // a deep clone
	});

	it('docks into the SELECTED container when one is selected', () => {
		const col = container('col1', 'col', [], { align: 'stretch' });
		const root = container('root', 'col', [col]);
		const s = state({
			monitor: { root, floating: [] },
			library: { version: 1, defs: [gaugeDef('def-1')] },
			selectedId: 'col1'
		});

		const next = { ...s, ...insertWidget(s, 'def-1') };
		const target = next.monitor.root.children[0] as Container;
		expect(isContainer(target)).toBe(true);
		expect(target.id).toBe('col1');
		expect(target.children).toHaveLength(1); // landed inside the selected col, not the root
		expect(next.monitor.root.children).toHaveLength(1); // root gained nothing else
	});

	it('is a no-op (empty patch) for an unknown def id', () => {
		const s = state({ library: { version: 1, defs: [gaugeDef('def-1')] } });
		expect(insertWidget(s, 'def-nope')).toEqual({});
	});

	it('is a no-op when there is no library at all', () => {
		expect(insertWidget(state(), 'def-1')).toEqual({});
	});

	it('gives repeated inserts fresh, non-colliding ids', () => {
		const s = state({ library: { version: 1, defs: [gaugeDef('def-1')] } });
		const a = (insertWidget(s, 'def-1').monitor as MonitorLayout).root.children[0];
		const b = (insertWidget(s, 'def-1').monitor as MonitorLayout).root.children[0];
		expect(a.id).not.toBe(b.id);
	});
});

describe('insertTemplate', () => {
	it('drops a built-in template as a self-contained inline group (no library def)', () => {
		const s = state();
		const patch = insertTemplate(s, CLOCK);

		// Pure: input tree unchanged.
		expect(s.monitor.root.children).toHaveLength(0);

		const next = { ...s, ...patch };
		expect(next.monitor.root.children).toHaveLength(1);
		const node = next.monitor.root.children[0];
		if (!isLeaf(node) || !isGroup(node.unit)) throw new Error('expected a group leaf');
		expect(node.unit.name).toBe('Clock (JP weekday)');
		expect(node.unit.def).toBeUndefined(); // inline child, NOT a library reference
		expect(node.unit.child).toBeTruthy();
		expect(node.unit.size).toEqual(getTemplate(CLOCK)?.size);
		expect(next.library).toBeUndefined(); // library untouched
		expect(next.selectedId).toBe(node.id);
	});

	it('remaps template-local ids to fresh ones (two inserts never collide)', () => {
		const s = state();
		const a = (insertTemplate(s, CLOCK).monitor as MonitorLayout).root.children[0] as Leaf;
		const b = (insertTemplate(s, CLOCK).monitor as MonitorLayout).root.children[0] as Leaf;

		// The group ids differ…
		expect(a.id).not.toBe(b.id);

		// …and so do every inner node id (no template-local id like 'dt-root' survives).
		const ids = (node: Leaf): string[] => {
			const out: string[] = [];
			const walk = (n: Container | Leaf): void => {
				out.push(n.id);
				if (isContainer(n)) n.children.forEach(walk);
				else if (isGroup(n.unit) && n.unit.child) walk(n.unit.child as Container | Leaf);
			};
			walk(node);
			return out;
		};
		const aIds = ids(a);
		const bIds = ids(b);
		expect(aIds.some((id) => id === 'dt-root')).toBe(false);
		expect(aIds.filter((id) => bIds.includes(id))).toEqual([]); // zero overlap
	});

	it('applies picked options through the ParamSpec path (12-hour time)', () => {
		const s = state();
		const next = { ...s, ...insertTemplate(s, CLOCK, { time: 'h:mm A' }) };
		const node = next.monitor.root.children[0] as Leaf;
		const grp = node.unit;
		if (!isGroup(grp)) throw new Error('expected a group');

		const hasFormat = (n: Container | Leaf, fmt: string): boolean => {
			if (isContainer(n)) return n.children.some((c) => hasFormat(c, fmt));
			if (isGroup(n.unit))
				return n.unit.child ? hasFormat(n.unit.child as Container | Leaf, fmt) : false;
			return n.unit.config?.format === fmt;
		};
		expect(hasFormat(grp.child as Container | Leaf, 'h:mm A')).toBe(true);
	});

	it('docks into the selected container when one is selected', () => {
		const col = container('col1', 'col', [], { align: 'stretch' });
		const s = state({
			monitor: { root: container('root', 'col', [col]), floating: [] },
			selectedId: 'col1'
		});
		const next = { ...s, ...insertTemplate(s, CLOCK) };
		const target = next.monitor.root.children[0] as Container;
		expect(target.id).toBe('col1');
		expect(target.children).toHaveLength(1); // inside the selected col
	});

	it('is a no-op (empty patch) for an unknown template id', () => {
		expect(insertTemplate(state(), 'no-such-template')).toEqual({});
	});
});

describe('defInUse', () => {
	it('is true when a group instance of the def sits on the monitor (floating)', () => {
		const s = state({
			monitor: { root: container('root', 'col', []), floating: [instanceOf('def-x')] }
		});
		expect(defInUse(s, 'def-x')).toBe(true);
	});

	it('is true when the instance is nested in the flow tree', () => {
		const inner = container('inner', 'col', [instanceOf('def-x')]);
		const s = state({ monitor: { root: container('root', 'col', [inner]), floating: [] } });
		expect(defInUse(s, 'def-x')).toBe(true);
	});

	it('is false when no instance of that def is placed', () => {
		const s = state({
			monitor: { root: container('root', 'col', []), floating: [instanceOf('def-other')] }
		});
		expect(defInUse(s, 'def-x')).toBe(false);
	});

	it('scans the REAL monitor (savedMonitor) while another def is being designed', () => {
		const savedMonitor: MonitorLayout = {
			root: container('root', 'col', []),
			floating: [instanceOf('def-x')]
		};
		const scoped: MonitorLayout = { root: container('scoped', 'col', []), floating: [] };
		const s = state({ editingDefId: 'def-y', savedMonitor, monitor: scoped });
		expect(defInUse(s, 'def-x')).toBe(true);
	});

	it('also scans the scoped editing tree (a composite def can embed this one)', () => {
		const savedMonitor: MonitorLayout = { root: container('root', 'col', []), floating: [] };
		const scoped: MonitorLayout = {
			root: container('scoped', 'col', [instanceOf('def-x')]),
			floating: []
		};
		const s = state({ editingDefId: 'def-y', savedMonitor, monitor: scoped });
		expect(defInUse(s, 'def-x')).toBe(true);
	});
});

describe('renameDef', () => {
	it('renames the matching def, leaving the others (and ids) unchanged', () => {
		const library: Library = {
			version: 1,
			defs: [gaugeDef('def-1', 'Old'), gaugeDef('def-2', 'Keep')]
		};
		const s = state({ library });

		const patch = renameDef(s, 'def-1', 'New');
		expect(s.library?.defs[0].name).toBe('Old'); // input untouched

		const defs = (patch.library as Library).defs;
		expect(defs[0]).toMatchObject({ id: 'def-1', name: 'New' });
		expect(defs[1]).toMatchObject({ id: 'def-2', name: 'Keep' });
	});

	it('preserves the library version and only patches the library', () => {
		const s = state({ library: { version: 7, defs: [gaugeDef('def-1', 'Old')] } });
		const patch = renameDef(s, 'def-1', 'New');
		expect((patch.library as Library).version).toBe(7);
		expect(Object.keys(patch)).toEqual(['library']);
	});

	it('is a no-op (empty patch) when there is no library', () => {
		expect(renameDef(state(), 'def-1', 'New')).toEqual({});
	});

	it('leaves the defs unchanged when the id matches nothing', () => {
		const s = state({ library: { version: 1, defs: [gaugeDef('def-1', 'Old')] } });
		const patch = renameDef(s, 'def-missing', 'New');
		expect((patch.library as Library).defs).toEqual(s.library?.defs);
	});
});

describe('deleteDef', () => {
	it('removes an unused def from the library', () => {
		const s = state({
			monitor: { root: container('root', 'col', []), floating: [] },
			library: { version: 1, defs: [gaugeDef('def-1'), gaugeDef('def-2')] }
		});

		const patch = deleteDef(s, 'def-1');
		expect(s.library?.defs).toHaveLength(2); // input untouched

		const defs = (patch.library as Library).defs;
		expect(defs).toHaveLength(1);
		expect(defs[0].id).toBe('def-2');
	});

	it('refuses to delete a def that is in use (returns empty patch)', () => {
		const s = state({
			monitor: { root: container('root', 'col', []), floating: [instanceOf('def-1')] },
			library: { version: 1, defs: [gaugeDef('def-1')] }
		});
		expect(deleteDef(s, 'def-1')).toEqual({});
	});

	it('refuses to delete the def currently being edited (returns empty patch)', () => {
		const s = state({
			library: { version: 1, defs: [gaugeDef('def-1')] },
			editingDefId: 'def-1'
		});
		expect(deleteDef(s, 'def-1')).toEqual({});
	});

	it('is a no-op (empty patch) when there is no library', () => {
		expect(deleteDef(state(), 'def-1')).toEqual({});
	});
});
