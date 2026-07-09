// Behavior tests for the editorOps the by-group suites left uncovered: the grid-CELL split path
// (splitNode with a cellIndex → splitGridCell / splitBandContainer), the floating-composite
// ungroup guard, the def-param/group/def-size/def-css ops, the global-token ops (setToken /
// setTokens / clearTokens), the monitor background op, plus the group/floating-skip branches of
// clearWidgetTokens and patchFloating. Each op is pure and returns a Patch (Partial<EditorState>);
// we apply it via spread and assert the resulting tree / library / token map / background — never
// internals — and cover each op's no-op branch alongside its main path.
import { describe, expect, it, vi } from 'vitest';
import {
	addDefParam,
	clearTokens,
	clearWidgetTokens,
	patchFloating,
	patchGroup,
	setBackground,
	setDefCss,
	setDefSize,
	setToken,
	setTokens,
	splitNode,
	ungroupSelected
} from './editorOps';
import { createWidget } from '../../core/widget';
import {
	container,
	emptyMonitorLayout,
	group,
	isContainer,
	leaf,
	type BackgroundSpec,
	type Container,
	type Group,
	type Leaf,
	type Library,
	type WidgetDef,
	type WidgetInstance
} from '../../core/layoutTree';
import type { EditorState } from './types';

// --- fixtures (mirrors editorOps.place.test.ts / editorOps.bulk.test.ts) ---------------------

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

const gauge = (id: string): WidgetInstance => createWidget('gauge', id);

// A WidgetDef with an inline child (what the def-* ops read/patch).
function gaugeDef(id: string, name = 'gauge'): WidgetDef {
	return { id, name, size: { w: 100, h: 80 }, child: container('def-inner', 'col', []) };
}

const stateWithLib = (defs: WidgetDef[], over: Partial<EditorState> = {}): EditorState => ({
	...minimalState(),
	library: { version: 1, defs },
	...over
});

// =============================================================================================
// splitNode — the grid-CELL path (cellIndex + grid → splitGridCell / splitBandContainer)
// =============================================================================================

describe('splitNode (grid-cell path)', () => {
	// An empty 2×2 grid placeholder: splitting cell 0 should materialise a band container AT that
	// cell, NOT re-kind/wrap the whole grid (which the non-cell path would do).
	function gridState(cellChildren: Container[] = []): EditorState {
		const s = minimalState();
		s.monitor.root = container('root', 'col', [
			container('g', 'grid', cellChildren, { cols: 2, rows: 2, align: 'stretch' })
		]);
		return s;
	}

	it('splits an empty leading cell (index 0) into a rows band WITHOUT padding earlier cells', () => {
		const s = gridState();
		const patch = splitNode(s, 'g', 'rows', 0);
		const grid = patch.monitor!.root.children[0] as Container;

		expect(grid.kind).toBe('grid'); // the grid is preserved, not re-kinded
		expect(grid.align).toBe('stretch');
		// exactly one band landed at index 0 (no spacer cells before it)
		expect(grid.children).toHaveLength(1);
		const band = grid.children[0] as Container;
		expect(isContainer(band)).toBe(true);
		// 'rows' band = a COL parent holding two ROW cells (see splitBandContainer)
		expect(band.kind).toBe('col');
		expect(band.children.map((c) => (c as Container).kind)).toEqual(['row', 'row']);
		expect(patch.selectedId).toBe(band.id);
	});

	it('pads earlier empty cells with spacers when the clicked cell index is past the child count', () => {
		const s = gridState();
		const patch = splitNode(s, 'g', 'cols', 2); // click cell 2 of an empty grid
		const grid = patch.monitor!.root.children[0] as Container;

		// 2 spacer col cells (indices 0,1) + the new band at index 2 = 3 children.
		expect(grid.children).toHaveLength(3);
		expect((grid.children[0] as Container).kind).toBe('col'); // spacer
		expect((grid.children[1] as Container).kind).toBe('col'); // spacer
		const band = grid.children[2] as Container;
		// 'cols' band = a ROW parent holding two COL cells
		expect(band.kind).toBe('row');
		expect(band.children.map((c) => (c as Container).kind)).toEqual(['col', 'col']);
		expect(patch.selectedId).toBe(band.id);
	});

	it('splits a grid cell into a nested 2×2 grid when dir is grid', () => {
		const s = gridState();
		const patch = splitNode(s, 'g', 'grid', 0);
		const grid = patch.monitor!.root.children[0] as Container;

		expect(grid.children).toHaveLength(1);
		const band = grid.children[0] as Container;
		expect(band.kind).toBe('grid'); // a fresh 2×2 grid materialised in the cell
		expect(band.cols).toBe(2);
		expect(band.rows).toBe(2);
		expect(band.children).toHaveLength(4);
		expect(patch.selectedId).toBe(band.id);
	});

	it('does not mutate the input state', () => {
		const s = gridState();
		splitNode(s, 'g', 'rows', 0);
		expect((s.monitor.root.children[0] as Container).children).toHaveLength(0);
	});
});

// =============================================================================================
// ungroupSelected — the floating-COMPOSITE guard (a group whose base is not a plain leaf)
// =============================================================================================

describe('ungroupSelected (floating composite guard)', () => {
	it('refuses to ungroup a floating group whose child is a CONTAINER (warns, empty patch)', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			// child is a container (composite), not a plain widget leaf → can't unwrap to a single unit.
			const g = group('grpC', { w: 120, h: 80 }, container('inner', 'col', [leaf(gauge('w1'))]), {
				config: { x: 10, y: 20 }
			});
			const s = minimalState();
			s.monitor.floating = [leaf(g)];

			expect(ungroupSelected(s, 'grpC')).toEqual({});
			expect(warn).toHaveBeenCalled();
			// the floating group is left in place
			expect(s.monitor.floating).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});
});

// =============================================================================================
// addDefParam
// =============================================================================================

describe('addDefParam', () => {
	it('appends a param (with target) to the matching def, leaving others untouched', () => {
		const s = stateWithLib([gaugeDef('def-1'), gaugeDef('def-2')]);
		const patch = addDefParam(s, 'def-1', 'core', 'unit.sensor');

		const defs = (patch.library as Library).defs;
		expect(defs[0].params).toEqual([{ key: 'core', target: 'unit.sensor' }]);
		expect(defs[1].params).toBeUndefined(); // sibling def untouched
		// input untouched (pure op)
		expect(s.library!.defs[0].params).toBeUndefined();
	});

	it('appends onto an existing params array and stores target undefined when blank', () => {
		const def = { ...gaugeDef('def-1'), params: [{ key: 'a' }] };
		const s = stateWithLib([def]);
		const patch = addDefParam(s, 'def-1', 'b'); // no target arg → target: undefined
		expect((patch.library as Library).defs[0].params).toEqual([
			{ key: 'a' },
			{ key: 'b', target: undefined }
		]);
	});

	it('is a no-op with no library or an empty key', () => {
		expect(addDefParam(minimalState(), 'def-1', 'k')).toEqual({});
		expect(addDefParam(stateWithLib([gaugeDef('def-1')]), 'def-1', '')).toEqual({});
	});
});

// =============================================================================================
// patchGroup
// =============================================================================================

describe('patchGroup', () => {
	it('merges a patch into a FLOW group leaf, leaving non-group leaves alone', () => {
		const s = minimalState();
		const g = group('grp1', { w: 120, h: 80 }, leaf(gauge('inner')), { name: 'old' });
		s.monitor.root = container('root', 'col', [leaf(g), leaf(gauge('plain'))]);

		const patch = patchGroup(s, 'grp1', { name: 'new' });
		const kids = patch.monitor!.root.children as Leaf[];
		expect((kids[0].unit as Group).name).toBe('new');
		expect((kids[0].unit as Group).size).toEqual({ w: 120, h: 80 }); // unspecified fields kept
		expect((kids[1].unit as WidgetInstance).type).toBe('gauge'); // sibling untouched
	});

	it('merges a patch into a FLOATING group leaf', () => {
		const s = minimalState();
		const g = group('grpF', { w: 50, h: 50 }, leaf(gauge('inner')));
		s.monitor.floating = [leaf(g)];

		const patch = patchGroup(s, 'grpF', { css: '.x{}' });
		expect((patch.monitor!.floating[0].unit as Group).css).toBe('.x{}');
	});

	it('leaves other floating leaves untouched when patching a floating group', () => {
		const s = minimalState();
		const g = group('grpF', { w: 50, h: 50 }, leaf(gauge('inner')));
		const bystander = leaf(gauge('bystander'));
		s.monitor.floating = [leaf(g), bystander];

		const patch = patchGroup(s, 'grpF', { name: 'renamed' });
		expect((patch.monitor!.floating[0].unit as Group).name).toBe('renamed');
		expect(patch.monitor!.floating[1]).toBe(bystander); // pass-through by reference
	});

	it('leaves the tree unchanged when the id is a non-group leaf', () => {
		const s = minimalState();
		s.monitor.root = container('root', 'col', [leaf(gauge('w1'))]);
		const patch = patchGroup(s, 'w1', { name: 'nope' });
		const unit = (patch.monitor!.root.children[0] as Leaf).unit as WidgetInstance;
		expect(unit.type).toBe('gauge');
		expect((unit as unknown as Group).name).toBeUndefined();
	});
});

// =============================================================================================
// setDefSize / setDefCss
// =============================================================================================

describe('setDefSize', () => {
	it('sets the def size, clamping each dimension to a minimum of 8', () => {
		const s = stateWithLib([gaugeDef('def-1')]);
		const patch = setDefSize(s, 'def-1', 200, 3); // h below the floor
		const defs = (patch.library as Library).defs;
		expect(defs[0].size).toEqual({ w: 200, h: 8 });
		expect(s.library!.defs[0].size).toEqual({ w: 100, h: 80 }); // input untouched
	});

	it('only patches the matching def', () => {
		const s = stateWithLib([gaugeDef('def-1'), gaugeDef('def-2')]);
		const defs = (setDefSize(s, 'def-2', 64, 64).library as Library).defs;
		expect(defs[0].size).toEqual({ w: 100, h: 80 }); // def-1 untouched
		expect(defs[1].size).toEqual({ w: 64, h: 64 });
	});

	it('is a no-op when there is no library', () => {
		expect(setDefSize(minimalState(), 'def-1', 10, 10)).toEqual({});
	});
});

describe('setDefCss', () => {
	it('sets the css on the matching def', () => {
		const s = stateWithLib([gaugeDef('def-1')]);
		const defs = (setDefCss(s, 'def-1', '.a{color:red}').library as Library).defs;
		expect(defs[0].css).toBe('.a{color:red}');
	});

	it('clears the css to undefined when given an empty string', () => {
		const def = { ...gaugeDef('def-1'), css: '.old{}' };
		const s = stateWithLib([def]);
		const defs = (setDefCss(s, 'def-1', '').library as Library).defs;
		expect(defs[0].css).toBeUndefined();
	});

	it('only patches the matching def, leaving siblings untouched', () => {
		const s = stateWithLib([gaugeDef('def-1'), { ...gaugeDef('def-2'), css: '.keep{}' }]);
		const defs = (setDefCss(s, 'def-1', '.new{}').library as Library).defs;
		expect(defs[0].css).toBe('.new{}');
		expect(defs[1].css).toBe('.keep{}'); // the non-matching def passes through
	});

	it('is a no-op when there is no library', () => {
		expect(setDefCss(minimalState(), 'def-1', '.x{}')).toEqual({});
	});
});

// =============================================================================================
// setToken / setTokens / clearTokens (global theme-token overrides)
// =============================================================================================

describe('setToken', () => {
	it('adds a token override when given a value', () => {
		const patch = setToken(minimalState(), '--accent', '#f00');
		expect(patch.tokenOverrides).toEqual({ '--accent': '#f00' });
	});

	it('removes the key when given an empty value', () => {
		const s = { ...minimalState(), tokenOverrides: { '--accent': '#f00', '--bg': '#000' } };
		const patch = setToken(s, '--accent', '');
		expect(patch.tokenOverrides).toEqual({ '--bg': '#000' });
		expect(s.tokenOverrides).toEqual({ '--accent': '#f00', '--bg': '#000' }); // input untouched
	});
});

describe('setTokens', () => {
	it('merges a map over the existing overrides, clearing keys with empty values', () => {
		const s = { ...minimalState(), tokenOverrides: { '--a': '1', '--b': '2' } };
		const patch = setTokens(s, { '--b': '', '--c': '3' }); // clear --b, keep --a, add --c
		expect(patch.tokenOverrides).toEqual({ '--a': '1', '--c': '3' });
	});

	it('is a no-op for an empty map (no undo entry)', () => {
		expect(setTokens(minimalState(), {})).toEqual({});
	});
});

describe('clearTokens', () => {
	it('drops every override when there is something to clear', () => {
		const s = { ...minimalState(), tokenOverrides: { '--a': '1' } };
		expect(clearTokens(s)).toEqual({ tokenOverrides: {} });
	});

	it('is a no-op when there are no overrides', () => {
		expect(clearTokens(minimalState())).toEqual({});
	});
});

// =============================================================================================
// setBackground (the monitor's full-screen background layer)
// =============================================================================================

describe('setBackground', () => {
	it('sets the monitor background spec', () => {
		const spec: BackgroundSpec = { kind: 'color', src: '#123' };
		const patch = setBackground(minimalState(), spec);
		expect(patch.monitor!.background).toEqual(spec);
	});

	it('clears an existing background when spec is undefined', () => {
		const s = minimalState();
		s.monitor.background = { kind: 'color', src: '#000' };
		const patch = setBackground(s, undefined);
		expect(patch.monitor!.background).toBeUndefined();
		expect('background' in patch.monitor!).toBe(false); // the field is deleted, not set undefined
	});

	it('is a no-op when clearing an already-empty background', () => {
		expect(setBackground(minimalState(), undefined)).toEqual({});
	});
});

// =============================================================================================
// clearWidgetTokens / patchFloating — the group / floating-skip branches
// =============================================================================================

describe('clearWidgetTokens (group branch)', () => {
	it('drops a GROUP leaf token map via the patchGroup route', () => {
		const s = minimalState();
		const g = group('grp1', { w: 80, h: 80 }, leaf(gauge('inner')), { tokens: { '--a': '1' } });
		s.monitor.root = container('root', 'col', [leaf(g)]);

		const patch = clearWidgetTokens(s, 'grp1');
		expect((patch.monitor!.root.children[0] as Leaf).unit.tokens).toBeUndefined();
	});
});

describe('patchFloating (group-skip branch)', () => {
	it('leaves a floating GROUP leaf untouched (only primitive floats are patched)', () => {
		const s = minimalState();
		const g = group('grpF', { w: 50, h: 50 }, leaf(gauge('inner')), { name: 'keep' });
		s.monitor.floating = [leaf(g)];

		const patch = patchFloating(s, 'grpF', { sensor: 'cpu.total' });
		const unit = patch.monitor!.floating[0].unit as Group;
		expect(unit.name).toBe('keep'); // a group leaf is skipped by patchFloating
		expect((unit as unknown as WidgetInstance).sensor).toBeUndefined();
	});
});
