// Behavior tests for the multi-selection / reset editorOps that the by-group files didn't reach:
// bulkPatchConfig, bulkSetBasis, resetWidget. Each is pure and returns a Patch; we assert the
// resulting tree (config / basis) and the no-op branches.
import { describe, expect, it } from 'vitest';
import {
	bulkPatchConfig,
	bulkSetBasis,
	clearWidgetTokens,
	patchFloating,
	patchUnit,
	resetWidget,
	setWidgetToken
} from './editorOps';
import { createWidget, getMeta } from '../../core/widget';
import {
	container,
	emptyMonitorLayout,
	group,
	isContainer,
	isGroup,
	leaf,
	type Leaf,
	type WidgetInstance
} from '../../core/layoutTree';
import type { EditorState } from './types';

const gauge = (id: string): WidgetInstance => createWidget('gauge', id);

// root(col) > [ leaf w1, leaf w2 ]
function stateWith(selectedId: string | null, selectedIds: string[]): EditorState {
	return {
		monitor: {
			...emptyMonitorLayout(),
			root: container('root', 'col', [leaf(gauge('w1')), leaf(gauge('w2'))])
		},
		library: undefined,
		selectedId,
		selectedIds,
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

const unitAt = (s: { monitor: { root: { children: unknown[] } } }, i: number): WidgetInstance =>
	((s.monitor.root.children[i] as Leaf).unit as WidgetInstance) ?? ({} as WidgetInstance);

describe('bulkPatchConfig', () => {
	it('sets a config key on every selected primitive (flow + floating)', () => {
		const s = stateWith('w1', ['w1', 'w2']);
		s.monitor.floating = [leaf(gauge('f1'))];
		s.selectedIds = ['w1', 'w2', 'f1'];
		const patch = bulkPatchConfig(s, 'unit', '%');
		expect(unitAt(patch as never, 0).config.unit).toBe('%');
		expect(unitAt(patch as never, 1).config.unit).toBe('%');
		expect((patch.monitor!.floating[0].unit as WidgetInstance).config.unit).toBe('%');
	});

	it('does not mutate the input state', () => {
		const s = stateWith('w1', ['w1']);
		const before = unitAt(s as never, 0).config.unit;
		bulkPatchConfig(s, 'unit', '%');
		expect(unitAt(s as never, 0).config.unit).toBe(before); // input unchanged
	});

	it('is a no-op with no selection', () => {
		expect(bulkPatchConfig(stateWith(null, []), 'x', 1)).toEqual({});
	});

	it('falls back to the single primary when the marquee set is empty', () => {
		const patch = bulkPatchConfig(stateWith('w1', []), 'probe', 'X');
		expect(unitAt(patch as never, 0).config.probe).toBe('X'); // the primary was patched
		expect(unitAt(patch as never, 1).config.probe).toBeUndefined(); // w2 untouched
	});

	it('skips floating leaves outside the selection and floating groups', () => {
		const s = stateWith('w1', ['w1', 'grpF']);
		const bystander = leaf(gauge('bystander'));
		const grpLeaf = leaf(group('grpF', { w: 10, h: 10 }, leaf(gauge('gi'))));
		s.monitor.floating = [bystander, grpLeaf];
		const patch = bulkPatchConfig(s, 'probe', 'X');
		expect(patch.monitor!.floating[0]).toBe(bystander); // not selected → pass-through
		expect(patch.monitor!.floating[1]).toBe(grpLeaf); // a selected GROUP is skipped too
	});

	it('leaves selected containers and flow groups untouched (primitives only)', () => {
		const s = stateWith('root', ['root', 'w1', 'grpT']);
		const grpLeaf = leaf(group('grpT', { w: 10, h: 10 }, leaf(gauge('gi'))));
		s.monitor.root.children.push(grpLeaf);
		const patch = bulkPatchConfig(s, 'probe', 'X');
		expect(unitAt(patch as never, 0).config.probe).toBe('X'); // the primitive was patched
		expect(isContainer(patch.monitor!.root)).toBe(true); // the container passed through
		expect(patch.monitor!.root.children[2]).toBe(grpLeaf); // the flow group passed through
	});
});

describe('bulkSetBasis', () => {
	it('sets the basis on selected flow leaves', () => {
		const patch = bulkSetBasis(stateWith('w1', ['w1', 'w2']), { fr: 2 });
		const c0 = patch.monitor!.root.children[0] as Leaf & { basis?: unknown };
		expect(c0.basis).toEqual({ fr: 2 });
	});

	it('clears the basis when given undefined', () => {
		const s = stateWith('w1', ['w1']);
		(s.monitor.root.children[0] as Leaf & { basis?: unknown }).basis = { fr: 3 };
		const patch = bulkSetBasis(s, undefined);
		expect((patch.monitor!.root.children[0] as Leaf & { basis?: unknown }).basis).toBeUndefined();
	});

	it('is a no-op with no selection', () => {
		expect(bulkSetBasis(stateWith(null, []), { fr: 1 })).toEqual({});
	});
});

describe('resetWidget', () => {
	it('restores a widget to its type meta defaults', () => {
		const s = stateWith('w1', []);
		(s.monitor.root.children[0] as Leaf).unit = { ...gauge('w1'), config: { unit: 'XXX' } };
		const patch = resetWidget(s, 'w1');
		expect(unitAt(patch as never, 0).config).toEqual(getMeta('gauge')?.defaultConfig ?? {});
	});

	it('is a no-op on a missing id or a non-leaf', () => {
		expect(resetWidget(stateWith(null, []), 'nope')).toEqual({});
		expect(resetWidget(stateWith(null, []), 'root')).toEqual({});
	});
});

describe('setWidgetToken / clearWidgetTokens', () => {
	it('sets a per-widget token, then clearing the last key drops the tokens object', () => {
		const set = setWidgetToken(stateWith(null, []), 'w1', '--accent', '#f00');
		expect(unitAt(set as never, 0).tokens).toEqual({ '--accent': '#f00' });

		const s = stateWith(null, []);
		(s.monitor.root.children[0] as Leaf).unit = { ...gauge('w1'), tokens: { '--accent': '#f00' } };
		const cleared = setWidgetToken(s, 'w1', '--accent', '');
		expect(unitAt(cleared as never, 0).tokens).toBeUndefined();
	});

	it('clearWidgetTokens drops all overrides; no-op when there are none / id missing', () => {
		const s = stateWith(null, []);
		(s.monitor.root.children[0] as Leaf).unit = { ...gauge('w1'), tokens: { a: '1' } };
		expect(unitAt(clearWidgetTokens(s, 'w1') as never, 0).tokens).toBeUndefined();
		expect(clearWidgetTokens(stateWith(null, []), 'w1')).toEqual({}); // no tokens
		expect(clearWidgetTokens(stateWith(null, []), 'missing')).toEqual({});
	});

	it('setWidgetToken is a no-op on a missing id or a container id', () => {
		expect(setWidgetToken(stateWith(null, []), 'missing', '--a', '1')).toEqual({});
		expect(setWidgetToken(stateWith(null, []), 'root', '--a', '1')).toEqual({});
	});

	it('setWidgetToken routes a GROUP leaf through the patchGroup path', () => {
		const s = stateWith(null, []);
		s.monitor.root.children.push(leaf(group('grpT', { w: 10, h: 10 }, leaf(gauge('gi')))));
		const patch = setWidgetToken(s, 'grpT', '--accent', '#0f0');
		const grp = patch.monitor!.root.children[2] as Leaf;
		expect(isGroup(grp.unit)).toBe(true);
		expect(grp.unit.tokens).toEqual({ '--accent': '#0f0' });
	});
});

describe('patchFloating / patchUnit', () => {
	it('patchFloating patches a floating leaf', () => {
		const s = stateWith(null, []);
		s.monitor.floating = [leaf(gauge('f1'))];
		const patch = patchFloating(s, 'f1', { sensor: 'cpu.total' });
		expect((patch.monitor!.floating[0].unit as WidgetInstance).sensor).toBe('cpu.total');
	});

	it('patchUnit routes to flow leaves and no-ops a non-leaf id', () => {
		const s = stateWith(null, []);
		const flow = patchUnit(s, 'w1', { sensor: 'mem.used' });
		expect(unitAt(flow as never, 0).sensor).toBe('mem.used');
		const noop = patchUnit(s, 'root', { sensor: 'x' }); // container id → tree unchanged
		expect(noop.monitor!.root.children).toHaveLength(2);
	});

	it('patchUnit routes a floating id to the floating layer', () => {
		const s = stateWith(null, []);
		s.monitor.floating = [leaf(gauge('f1'))];
		const patch = patchUnit(s, 'f1', { sensor: 'cpu.total' });
		expect((patch.monitor!.floating[0].unit as WidgetInstance).sensor).toBe('cpu.total');
	});
});
