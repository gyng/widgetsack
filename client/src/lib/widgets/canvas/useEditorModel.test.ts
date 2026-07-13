// The Canvas editor model's reducer — driven through the hook because the reducer + Action union are
// internal to useEditorModel (only the hook, the op helpers, and editHelpers are exported). This
// file targets the reducer paths the existing canvas tests (previewTemplate / insertTemplate /
// useKeyboard / useStudioInit) leave uncovered: selection, undo/redo + history, the op-apply commit
// chokepoint, the def-edit mode switches, the load/theme/baseline actions, and the handleOp switch.
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useEditorModel } from './useEditorModel';
import {
	container,
	isContainer,
	isGroup,
	isLeaf,
	leaf,
	type Library,
	type MonitorLayout,
	type WidgetInstance
} from '../../core/layoutTree';
import { createWidget } from '../../core/widget';

const ROOT = 'root'; // emptyRoot()'s container id

// Render the model with the root container selected, so addWidget docks into the flow tree (with
// nothing selected, addWidget would drop the widget on the FLOATING layer instead). Returns the hook.
function renderModel() {
	const r = renderHook(() => useEditorModel(true, []));
	act(() => r.result.current.handleOp({ op: 'select', id: ROOT }));
	return r;
}

// Render the model and add `count` flow widgets via handleOp (each its own commit / undo step). Returns
// the hook result + the placed widget ids in insertion order. Re-selects the root before each add so
// every widget lands as a direct root child (addWidget targets the currently-selected container).
// `resetHistory` first: the initial state has historyReady=false, so commits don't record undo until
// the layout is "loaded" (the Canvas dispatches resetHistory after load) — mirror that here.
function modelWith(count: number) {
	const { result } = renderModel();
	act(() => result.current.dispatch({ type: 'resetHistory' }));
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		act(() => result.current.handleOp({ op: 'select', id: ROOT }));
		act(() => result.current.handleOp({ op: 'addWidget', widgetType: 'text' }));
		ids.push(result.current.state.selectedId!);
	}
	return { result, ids };
}

// A tiny monitor with one docked text widget under the root (handy for `load` / baseline fixtures).
function oneWidgetMonitor(id = 'w-fix'): MonitorLayout {
	const root = container('root', 'col', [leaf(createWidget('text', id))], { align: 'stretch' });
	return { root, floating: [] };
}

describe('selection sub-reducer', () => {
	it('select sets selectedId and collapses any marquee to the single primary', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.dispatch({ type: 'setSelectedIds', ids: ['a', 'b'], primary: 'a' }));
		expect(result.current.state.selectedIds).toEqual(['a', 'b']);

		act(() => result.current.dispatch({ type: 'select', id: 'c' }));
		expect(result.current.state.selectedId).toBe('c');
		// syncPrimary collapses the stale marquee down to just the new primary.
		expect(result.current.state.selectedIds).toEqual(['c']);
		expect(result.current.state.lastPrimary).toBe('c');
	});

	it('select with id already the primary is a no-op for the marquee set', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.dispatch({ type: 'setSelectedIds', ids: ['a', 'b'], primary: 'a' }));
		// selecting the SAME id as the current primary leaves selectedId === lastPrimary, so syncPrimary
		// bails early and the marquee set survives.
		act(() => result.current.dispatch({ type: 'select', id: 'a' }));
		expect(result.current.state.selectedIds).toEqual(['a', 'b']);
	});

	it('selectClick sets both selectedId and selectedIds and marks them synced', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.dispatch({ type: 'setSelectedIds', ids: ['a', 'b'], primary: 'a' }));
		act(() => result.current.dispatch({ type: 'selectClick', id: 'z' }));
		const s = result.current.state;
		expect(s.selectedId).toBe('z');
		expect(s.selectedIds).toEqual(['z']);
		expect(s.lastPrimary).toBe('z');
	});

	it('setSelectedIds is authoritative (set + primary) and survives a follow-up no-op sync', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() =>
			result.current.dispatch({ type: 'setSelectedIds', ids: ['x', 'y', 'z'], primary: 'y' })
		);
		const s = result.current.state;
		expect(s.selectedIds).toEqual(['x', 'y', 'z']);
		expect(s.selectedId).toBe('y');
		expect(s.lastPrimary).toBe('y');
	});
});

describe('op-apply path (commit chokepoint)', () => {
	it('commitOp applies the patch, records undo, and bumps saveSeq', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		const seq0 = result.current.state.saveSeq;
		act(() => result.current.commitOp((s) => ({ monitor: { ...s.monitor, floating: [] } })));
		// Even a no-op-shaped patch bumps saveSeq (the persistence effect fires on the seq, the undo
		// recorder dedupes by reference).
		expect(result.current.state.saveSeq).toBe(seq0 + 1);
	});

	it('a real commit edit pushes one undo entry and clears redo (after history is ready)', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		// historyReady is false until the first resetHistory (the post-load re-anchor) — commits before
		// then don't record undo.
		act(() => result.current.dispatch({ type: 'resetHistory' }));
		act(() => result.current.handleOp({ op: 'addWidget', widgetType: 'text' }));
		expect(result.current.state.undoStack.length).toBe(1);
		expect(result.current.state.redoStack).toEqual([]);
	});

	it('commits made before resetHistory do NOT record undo (historyReady gate)', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.handleOp({ op: 'addWidget', widgetType: 'text' }));
		expect(result.current.state.undoStack).toEqual([]);
	});

	it('a commit with history enabled but no anchor snapshot self-anchors (lastSnap ?? snap)', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		// A load patch can enable history without carrying a baseline snapshot; the first commit then
		// anchors undo to its own result instead of reading a null lastSnap.
		act(() => result.current.dispatch({ type: 'load', patch: { historyReady: true } }));
		act(() => result.current.commitOp((s) => ({ monitor: { ...s.monitor } })));
		const s = result.current.state;
		expect(s.undoStack).toHaveLength(1);
		expect(s.undoStack[0].monitor).toBe(s.monitor); // self-anchored: the pushed snap IS the new state
		expect(s.lastSnap?.monitor).toBe(s.monitor);
	});

	it('mutateNoSave applies the patch WITHOUT recording undo or bumping saveSeq', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		const seq0 = result.current.state.saveSeq;
		act(() =>
			result.current.mutateNoSave((s) => ({ selectedId: 'transient', monitor: s.monitor }))
		);
		expect(result.current.state.selectedId).toBe('transient');
		expect(result.current.state.saveSeq).toBe(seq0);
		expect(result.current.state.undoStack).toEqual([]);
	});

	it('an op patch that sets selectedId (without selectedIds) collapses the marquee', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.dispatch({ type: 'setSelectedIds', ids: ['a', 'b'], primary: 'a' }));
		act(() => result.current.mutateNoSave(() => ({ selectedId: 'solo' })));
		expect(result.current.state.selectedIds).toEqual(['solo']);
	});

	it('an op patch that sets selectedIds is authoritative (the set is NOT collapsed)', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() =>
			result.current.mutateNoSave(() => ({ selectedId: 'p', selectedIds: ['p', 'q', 'r'] }))
		);
		expect(result.current.state.selectedIds).toEqual(['p', 'q', 'r']);
	});

	it('plain patch action applies + syncs primary without committing', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		const seq0 = result.current.state.saveSeq;
		act(() => result.current.dispatch({ type: 'patch', patch: { selectedId: 'pp' } }));
		expect(result.current.state.selectedId).toBe('pp');
		expect(result.current.state.selectedIds).toEqual(['pp']); // collapsed
		expect(result.current.state.saveSeq).toBe(seq0);
	});
});

describe('history sub-reducer (undo / redo)', () => {
	it('undo reverts the monitor to the previous snapshot', () => {
		const { result, ids } = modelWith(2);
		expect(result.current.state.monitor.root.children).toHaveLength(2);
		const beforeUndo = result.current.state.monitor;

		act(() => result.current.dispatch({ type: 'undo' }));
		const s = result.current.state;
		expect(s.monitor.root.children).toHaveLength(1);
		expect(s.monitor.root.children[0].id).toBe(ids[0]);
		expect(s.redoStack).toHaveLength(1); // the undone state is on the redo branch
		expect(s.redoStack[0].monitor).toBe(beforeUndo);
	});

	it('redo re-applies an undone edit', () => {
		const { result } = modelWith(2);
		act(() => result.current.dispatch({ type: 'undo' }));
		expect(result.current.state.monitor.root.children).toHaveLength(1);
		act(() => result.current.dispatch({ type: 'redo' }));
		expect(result.current.state.monitor.root.children).toHaveLength(2);
		expect(result.current.state.redoStack).toEqual([]);
	});

	it('undo on an empty stack is a no-op (same state reference)', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'undo' }));
		expect(result.current.state).toBe(before);
	});

	it('redo on an empty stack is a no-op', () => {
		const { result } = modelWith(1);
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'redo' }));
		expect(result.current.state).toBe(before);
	});

	it('a fresh edit after an undo clears the redo branch', () => {
		const { result } = modelWith(2);
		act(() => result.current.dispatch({ type: 'undo' }));
		expect(result.current.state.redoStack).toHaveLength(1);
		act(() => result.current.handleOp({ op: 'addWidget', widgetType: 'text' }));
		expect(result.current.state.redoStack).toEqual([]); // recordHistory cleared it
	});

	it('multiple edits then undo walks back one step at a time', () => {
		const { result } = modelWith(3);
		expect(result.current.state.monitor.root.children).toHaveLength(3);
		act(() => result.current.dispatch({ type: 'undo' }));
		expect(result.current.state.monitor.root.children).toHaveLength(2);
		act(() => result.current.dispatch({ type: 'undo' }));
		expect(result.current.state.monitor.root.children).toHaveLength(1);
	});
});

describe('history reset + baseline', () => {
	it('resetHistory clears both stacks and re-anchors lastSnap', () => {
		const { result } = modelWith(2);
		expect(result.current.state.undoStack.length).toBeGreaterThan(0);
		act(() => result.current.dispatch({ type: 'resetHistory' }));
		const s = result.current.state;
		expect(s.undoStack).toEqual([]);
		expect(s.redoStack).toEqual([]);
		expect(s.historyReady).toBe(true);
		expect(s.lastSnap?.monitor).toBe(s.monitor);
	});

	it('setBaseline captures the current monitor/library/theme/tokens as the saved baseline', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.dispatch({ type: 'setTheme', name: 'builtin:dark' }));
		act(() => result.current.handleOp({ op: 'setToken', key: '--accent', value: '#f00' }));
		act(() => result.current.dispatch({ type: 'setBaseline' }));
		const b = result.current.state.savedBaseline!;
		expect(b).not.toBeNull();
		expect(b.monitor).toBe(result.current.state.monitor);
		expect(b.theme).toBe('builtin:dark');
		expect(b.globalTheme).toBe('builtin:dark');
		expect(b.tokens).toEqual({ '--accent': '#f00' });
	});

	it('keeps the global inherit-theme separate in an unlocked baseline', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() =>
			result.current.dispatch({
				type: 'load',
				patch: {
					selectedTheme: 'monitor-theme',
					themeLock: false,
					globalTheme: 'global-inherit-theme'
				}
			})
		);
		act(() => result.current.dispatch({ type: 'setBaseline' }));

		expect(result.current.state.savedBaseline).toMatchObject({
			theme: 'monitor-theme',
			themeLock: false,
			globalTheme: 'global-inherit-theme'
		});
	});

	it('setBaseline mid-def-edit also re-anchors the def-edit baseline to the scoped monitor', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.dispatch({ type: 'newWidget' }));
		expect(result.current.state.editingDefId).not.toBeNull();
		act(() => result.current.dispatch({ type: 'setBaseline' }));
		expect(result.current.state.defEditBaseline).toBe(result.current.state.monitor);
	});
});

describe('def-edit sub-reducer', () => {
	it('newWidget appends an empty def, enters def-edit, and stashes the real monitor', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		const realMonitor = result.current.state.monitor;
		act(() => result.current.dispatch({ type: 'newWidget' }));
		const s = result.current.state;
		expect(s.library?.defs).toHaveLength(1);
		expect(s.editingDefId).toBe(s.library!.defs[0].id);
		expect(s.savedMonitor).toBe(realMonitor); // the live layout is preserved untouched
		expect(s.defEditBaseline).toBe(s.monitor); // scoped monitor as the def-edit baseline
		expect(s.selectedId).toBeNull();
		expect(s.undoStack).toEqual([]); // history reset on entering the scope
	});

	it('newWidget is refused while already editing a def (would orphan savedMonitor)', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.dispatch({ type: 'newWidget' }));
		const firstDefId = result.current.state.editingDefId;
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'newWidget' }));
		expect(result.current.state).toBe(before); // unchanged
		expect(result.current.state.editingDefId).toBe(firstDefId);
		expect(result.current.state.library?.defs).toHaveLength(1);
	});

	it('cloneDef duplicates an existing def (-copy) and enters def-edit on the copy', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		// Seed a library def, then leave def-edit so a clone is allowed.
		act(() => result.current.dispatch({ type: 'newWidget' }));
		const srcId = result.current.state.editingDefId!;
		act(() => result.current.dispatch({ type: 'endDefEdit' }));

		act(() => result.current.dispatch({ type: 'cloneDef', defId: srcId }));
		const s = result.current.state;
		expect(s.library?.defs).toHaveLength(2);
		const copy = s.library!.defs.find((d) => d.id !== srcId)!;
		expect(copy.name.endsWith('-copy')).toBe(true);
		expect(s.editingDefId).toBe(copy.id);
	});

	it('cloneDef copies the source css + params by value onto the copy', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		// Seed a def carrying css + params (the optional fields cloneDef must carry over).
		act(() => result.current.dispatch({ type: 'newWidget' }));
		const srcId = result.current.state.editingDefId!;
		act(() => result.current.dispatch({ type: 'endDefEdit' }));
		act(() => result.current.handleOp({ op: 'setDefCss', defId: srcId, css: '.a{}' }));
		act(() =>
			result.current.handleOp({ op: 'addDefParam', defId: srcId, key: 'core', target: 'unit.s' })
		);

		act(() => result.current.dispatch({ type: 'cloneDef', defId: srcId }));
		const s = result.current.state;
		const copy = s.library!.defs.find((d) => d.id !== srcId)!;
		expect(copy.css).toBe('.a{}');
		expect(copy.params).toEqual([{ key: 'core', target: 'unit.s' }]);
		// params are cloned per-entry, not shared with the source def.
		const src = s.library!.defs.find((d) => d.id === srcId)!;
		expect(copy.params![0]).not.toBe(src.params![0]);
	});

	it('cloneDef is a no-op for an unknown def id', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'cloneDef', defId: 'nope' }));
		expect(result.current.state).toBe(before);
	});

	it('cloneDef is refused while already editing a def', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.dispatch({ type: 'newWidget' }));
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'cloneDef', defId: before.editingDefId! }));
		expect(result.current.state).toBe(before);
	});

	it('newFromTemplate is refused while already editing a def', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.dispatch({ type: 'newWidget' }));
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'newFromTemplate', templateId: 'clock-jp' }));
		expect(result.current.state).toBe(before);
	});

	it('enterDefEdit scopes the monitor to the def and stashes the real layout', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.dispatch({ type: 'newWidget' }));
		const defId = result.current.state.editingDefId!;
		// Fold the open def first; now re-enter via the handleOp editDef path.
		act(() => result.current.dispatch({ type: 'endDefEdit' }));
		const realMonitor = result.current.state.monitor;
		act(() => result.current.handleOp({ op: 'editDef', defId }));
		const s = result.current.state;
		expect(s.editingDefId).toBe(defId);
		expect(s.savedMonitor).toBe(realMonitor);
		expect(s.monitor.root.id).toContain(defId); // scopedMonitorFromDef rooted the def's child
	});

	it('enterDefEdit is refused while another def is already open', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.dispatch({ type: 'newWidget' }));
		const open = result.current.state.editingDefId;
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'enterDefEdit', defId: 'whatever' }));
		expect(result.current.state).toBe(before);
		expect(result.current.state.editingDefId).toBe(open);
	});

	it('enterDefEdit is a no-op for an unknown def id', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'enterDefEdit', defId: 'nope' }));
		expect(result.current.state).toBe(before);
	});

	it('endDefEdit writes back only the edited def; other library defs pass through untouched', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.dispatch({ type: 'newWidget' }));
		const firstId = result.current.state.editingDefId!;
		act(() => result.current.dispatch({ type: 'endDefEdit' }));
		const firstDef = result.current.state.library!.defs.find((d) => d.id === firstId)!;
		act(() => result.current.dispatch({ type: 'newWidget' })); // a second def, now being edited
		act(() => result.current.dispatch({ type: 'endDefEdit' }));
		const s = result.current.state;
		expect(s.library?.defs).toHaveLength(2);
		expect(s.library?.defs.find((d) => d.id === firstId)).toBe(firstDef); // same object: untouched
	});

	it('endDefEdit writes the scoped tree back onto the def, restores the monitor, and commits', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		const realMonitor = result.current.state.monitor;
		act(() => result.current.dispatch({ type: 'newWidget' }));
		const defId = result.current.state.editingDefId!;
		const seqBefore = result.current.state.saveSeq;
		// Edit the scoped tree (add a widget into the def's root) before folding it back.
		act(() => result.current.handleOp({ op: 'addWidget', widgetType: 'text' }));
		const editedScopedRoot = result.current.state.monitor.root;

		act(() => result.current.dispatch({ type: 'endDefEdit' }));
		const s = result.current.state;
		expect(s.editingDefId).toBeNull();
		expect(s.savedMonitor).toBeNull();
		expect(s.monitor).toBe(realMonitor); // back on the real layout
		const def = s.library!.defs.find((d) => d.id === defId)!;
		expect(def.child).toBe(editedScopedRoot); // the scoped edit was synced into the def
		expect(s.saveSeq).toBeGreaterThan(seqBefore); // endDefEdit runs a commit (saveLayout)
	});

	it('endDefEdit is a no-op when not editing a def', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'endDefEdit' }));
		expect(result.current.state).toBe(before);
	});

	it('newFromTemplate with an unknown template id is a no-op', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'newFromTemplate', templateId: 'no-such' }));
		expect(result.current.state).toBe(before);
	});

	it('newFromTemplate of a LEAF-rooted template wraps the leaf in a scoped col root', () => {
		// The nowplaying template's tree is a single leaf (not a container); scopedMonitorFromDef must
		// synthesize a col root around it so the def editor has a container to edit.
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.dispatch({ type: 'newFromTemplate', templateId: 'nowplaying' }));
		const s = result.current.state;
		expect(s.editingDefId).not.toBeNull();
		expect(s.monitor.root.kind).toBe('col');
		expect(s.monitor.root.id).toBe(`${s.editingDefId}__root`);
		// The def itself keeps the raw leaf child (the synthesized root is only the EDITING scope).
		const def = s.library!.defs.find((d) => d.id === s.editingDefId)!;
		expect(isLeaf(def.child)).toBe(true);
	});
});

describe('load / theme / monitor sub-reducer', () => {
	it('load bulk-applies the supplied patch', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		const mon = oneWidgetMonitor();
		const library: Library = { version: 1, defs: [] };
		act(() =>
			result.current.dispatch({
				type: 'load',
				patch: { monitor: mon, library, selectedTheme: 'builtin:nord' }
			})
		);
		const s = result.current.state;
		expect(s.monitor).toBe(mon);
		expect(s.library).toBe(library);
		expect(s.selectedTheme).toBe('builtin:nord');
	});

	it('setTheme mirrors selectedTheme only', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.dispatch({ type: 'setTheme', name: 'builtin:solarized' }));
		expect(result.current.state.selectedTheme).toBe('builtin:solarized');
	});

	it('replaceMonitor swaps the monitor wholesale (no commit)', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		const seq0 = result.current.state.saveSeq;
		const mon = oneWidgetMonitor('rep');
		act(() => result.current.dispatch({ type: 'replaceMonitor', monitor: mon }));
		expect(result.current.state.monitor).toBe(mon);
		expect(result.current.state.saveSeq).toBe(seq0);
	});

	it('setMonitorKey leaves the state reference untouched (a marker action)', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'setMonitorKey' }));
		expect(result.current.state).toBe(before);
	});

	it('revertToBaseline restores the saved baseline and clears pendingExtras', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		const baselineMon = oneWidgetMonitor('base');
		const baselineLib: Library = { version: 1, defs: [] };
		// Establish a baseline via load + setBaseline, then drift the editor, then revert.
		act(() =>
			result.current.dispatch({
				type: 'load',
				patch: {
					monitor: baselineMon,
					library: baselineLib,
					selectedTheme: 'builtin:dark',
					tokenOverrides: { '--accent': '#abc' }
				}
			})
		);
		act(() => result.current.dispatch({ type: 'setBaseline' }));
		// Drift: change theme + add a widget + queue an extra.
		act(() => result.current.dispatch({ type: 'setTheme', name: 'changed' }));
		act(() => result.current.handleOp({ op: 'addWidget', widgetType: 'text' }));
		act(() =>
			result.current.dispatch({
				type: 'patch',
				patch: { pendingExtras: [{ key: 'k', leaf: leaf(createWidget('text', 'extra')) }] }
			})
		);

		act(() => result.current.dispatch({ type: 'revertToBaseline' }));
		const s = result.current.state;
		expect(s.monitor).toBe(baselineMon);
		expect(s.library).toBe(baselineLib);
		expect(s.selectedTheme).toBe('builtin:dark');
		expect(s.tokenOverrides).toEqual({ '--accent': '#abc' });
		expect(s.pendingExtras).toEqual([]);
	});

	it('revertToBaseline is a no-op when no baseline was ever captured', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.handleOp({ op: 'addWidget', widgetType: 'text' }));
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'revertToBaseline' }));
		expect(result.current.state).toBe(before);
	});
});

describe('handleOp switch (Inspector / Outline / menu funnel)', () => {
	it('select routes to a non-saving selection', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		const seq0 = result.current.state.saveSeq;
		act(() => result.current.handleOp({ op: 'select', id: 'sel' }));
		expect(result.current.state.selectedId).toBe('sel');
		expect(result.current.state.saveSeq).toBe(seq0); // selection isn't persisted
	});

	it('addContainer / split / collapse / remove drive the flow tree and commit', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		// addContainer into the root.
		act(() => result.current.handleOp({ op: 'addContainer', kind: 'row' }));
		const rowId = result.current.state.selectedId!;
		expect(result.current.state.monitor.root.children.map((c) => c.id)).toContain(rowId);

		// split the new row into rows.
		act(() => result.current.handleOp({ op: 'split', id: rowId, dir: 'rows' }));
		const splitNode = result.current.state.monitor.root.children.find((c) => c.id === rowId)!;
		expect(isContainer(splitNode) && splitNode.children.length).toBeGreaterThan(0);

		// collapse it back.
		act(() => result.current.handleOp({ op: 'collapse', id: rowId }));
		expect(result.current.state.selectedId).toBe(rowId);

		// remove it.
		act(() => result.current.handleOp({ op: 'remove', id: rowId }));
		expect(result.current.state.monitor.root.children.map((c) => c.id)).not.toContain(rowId);
	});

	it('moveUp / moveDown / indent / outdent reorder and reparent siblings', () => {
		// Two sibling containers under the root (containerId pins them to root level, since addContainer
		// otherwise targets the just-selected container — which would nest them).
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.handleOp({ op: 'addContainer', kind: 'col', containerId: ROOT }));
		const aId = result.current.state.selectedId!;
		act(() => result.current.handleOp({ op: 'addContainer', kind: 'col', containerId: ROOT }));
		const bId = result.current.state.selectedId!;
		const order0 = result.current.state.monitor.root.children.map((c) => c.id);
		expect(order0).toEqual([aId, bId]);

		act(() => result.current.handleOp({ op: 'moveUp', id: bId }));
		expect(result.current.state.monitor.root.children.map((c) => c.id)).toEqual([bId, aId]);
		act(() => result.current.handleOp({ op: 'moveDown', id: bId }));
		expect(result.current.state.monitor.root.children.map((c) => c.id)).toEqual([aId, bId]);

		// indent b into a (the previous sibling container), then outdent it back to the root.
		act(() => result.current.handleOp({ op: 'indent', id: bId }));
		const aNode = result.current.state.monitor.root.children[0];
		expect(isContainer(aNode) && aNode.children.map((c) => c.id)).toContain(bId);
		act(() => result.current.handleOp({ op: 'outdent', id: bId }));
		expect(result.current.state.monitor.root.children.map((c) => c.id)).toContain(bId);
	});

	it('addWidgetAt / float / dock move a leaf between the flow and floating layers', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		// Drop a floating widget on the stage.
		act(() => result.current.handleOp({ op: 'addWidgetAt', widgetType: 'text', x: 100, y: 50 }));
		const id = result.current.state.selectedId!;
		expect(result.current.state.monitor.floating.map((l) => l.id)).toContain(id);

		// Dock it into the flow root, then float it back out.
		act(() => result.current.handleOp({ op: 'dock', id }));
		expect(result.current.state.monitor.root.children.map((c) => c.id)).toContain(id);
		act(() => result.current.handleOp({ op: 'float', id }));
		expect(result.current.state.monitor.floating.map((l) => l.id)).toContain(id);
	});

	it('makeWidget wraps a leaf into a group + library def; ungroup inlines it back', () => {
		const { result } = renderModel();
		act(() => result.current.handleOp({ op: 'addWidget', widgetType: 'text' }));
		const id = result.current.state.selectedId!;
		act(() => result.current.handleOp({ op: 'makeWidget', id }));
		const s1 = result.current.state;
		expect(s1.library?.defs.length).toBe(1);
		const grpId = s1.selectedId!;
		const grpNode = s1.monitor.root.children.find((c) => c.id === grpId)!;
		expect(isLeaf(grpNode) && isGroup(grpNode.unit)).toBe(true);

		act(() => result.current.handleOp({ op: 'ungroup', id: grpId }));
		// ungroup leaves the underlying widget in the tree (inlined) — the group leaf is gone.
		const after = result.current.state.monitor.root.children;
		expect(after.some((c) => isLeaf(c) && isGroup(c.unit))).toBe(false);
	});

	it('insertWidget instantiates a library def as a new group into the flow', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		// Seed a def via newWidget → endDefEdit so the library has one.
		act(() => result.current.dispatch({ type: 'newWidget' }));
		const defId = result.current.state.editingDefId!;
		act(() => result.current.dispatch({ type: 'endDefEdit' }));
		act(() => result.current.handleOp({ op: 'insertWidget', defId }));
		const grpId = result.current.state.selectedId!;
		const node = result.current.state.monitor.root.children.find((c) => c.id === grpId)!;
		expect(isLeaf(node) && isGroup(node.unit) && node.unit.def).toBe(defId);
	});

	it('renameDef / setDefSize / setDefCss / addDefParam mutate a library def; deleteDef removes it', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.dispatch({ type: 'newWidget' }));
		const defId = result.current.state.editingDefId!;
		act(() => result.current.dispatch({ type: 'endDefEdit' }));

		act(() => result.current.handleOp({ op: 'renameDef', defId, name: 'renamed' }));
		act(() => result.current.handleOp({ op: 'setDefSize', defId, w: 321, h: 222 }));
		act(() => result.current.handleOp({ op: 'setDefCss', defId, css: '.x{}' }));
		act(() => result.current.handleOp({ op: 'addDefParam', defId, key: 'core', target: 'unit.s' }));
		const def = result.current.state.library!.defs.find((d) => d.id === defId)!;
		expect(def.name).toBe('renamed');
		expect(def.size).toEqual({ w: 321, h: 222 });
		expect(def.css).toBe('.x{}');
		expect(def.params).toEqual([{ key: 'core', target: 'unit.s' }]);

		act(() => result.current.handleOp({ op: 'deleteDef', defId }));
		expect(result.current.state.library!.defs.find((d) => d.id === defId)).toBeUndefined();
	});

	it('token ops: setToken / setTokens / clearTokens', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.handleOp({ op: 'setToken', key: '--a', value: '#1' }));
		act(() => result.current.handleOp({ op: 'setTokens', tokens: { '--b': '#2', '--c': '#3' } }));
		expect(result.current.state.tokenOverrides).toEqual({ '--a': '#1', '--b': '#2', '--c': '#3' });
		act(() => result.current.handleOp({ op: 'clearTokens' }));
		expect(result.current.state.tokenOverrides).toEqual({});
	});

	it('setBackground sets and clears the monitor background', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() =>
			result.current.handleOp({ op: 'setBackground', spec: { kind: 'color', src: '#000' } })
		);
		expect(result.current.state.monitor.background).toEqual({ kind: 'color', src: '#000' });
		act(() => result.current.handleOp({ op: 'setBackground', spec: undefined }));
		expect(result.current.state.monitor.background).toBeUndefined();
	});

	it('per-widget token ops: setWidgetToken then clearWidgetTokens', () => {
		const { result } = renderModel();
		act(() => result.current.handleOp({ op: 'addWidget', widgetType: 'text' }));
		const id = result.current.state.selectedId!;
		act(() => result.current.handleOp({ op: 'setWidgetToken', id, key: '--fg', value: '#fff' }));
		const node1 = result.current.state.monitor.root.children.find((c) => c.id === id)!;
		expect(isLeaf(node1) && node1.unit.tokens).toEqual({ '--fg': '#fff' });
		act(() => result.current.handleOp({ op: 'clearWidgetTokens', id }));
		const node2 = result.current.state.monitor.root.children.find((c) => c.id === id)!;
		expect(isLeaf(node2) && node2.unit.tokens).toBeUndefined();
	});

	it('patchWidget / resetWidget / setBasis / setLeafAlign / setLeafBox edit a flow leaf', () => {
		const { result } = renderModel();
		act(() => result.current.handleOp({ op: 'addWidget', widgetType: 'text' }));
		const id = result.current.state.selectedId!;

		act(() => result.current.handleOp({ op: 'patchWidget', id, patch: { config: { custom: 1 } } }));
		act(() => result.current.handleOp({ op: 'setBasis', id, basis: { fr: 2 } }));
		act(() => result.current.handleOp({ op: 'setLeafAlign', id, halign: 'center', valign: 'top' }));
		act(() => result.current.handleOp({ op: 'setLeafBox', id, field: 'pad', value: 7 }));
		const node = result.current.state.monitor.root.children.find((c) => c.id === id)!;
		expect(isLeaf(node) && (node.unit as WidgetInstance).config.custom).toBe(1);
		expect(isLeaf(node) && node.basis).toEqual({ fr: 2 });
		expect(isLeaf(node) && node.halign).toBe('center');
		expect(isLeaf(node) && node.valign).toBe('top');
		expect(isLeaf(node) && node.pad).toBe(7);

		// resetWidget restores config back to the type defaults (custom key gone).
		act(() => result.current.handleOp({ op: 'resetWidget', id }));
		const reset = result.current.state.monitor.root.children.find((c) => c.id === id)!;
		expect(isLeaf(reset) && (reset.unit as WidgetInstance).config.custom).toBeUndefined();
	});

	it('patchContainer / distributeEvenly edit a container; reparent moves a node into it', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.handleOp({ op: 'addContainer', kind: 'col' }));
		const colId = result.current.state.selectedId!;
		act(() => result.current.handleOp({ op: 'patchContainer', id: colId, patch: { gap: 12 } }));
		const colNode = result.current.state.monitor.root.children.find((c) => c.id === colId)!;
		expect(isContainer(colNode) && colNode.gap).toBe(12);

		// Add a widget then reparent it into the col, then distributeEvenly across the col.
		act(() => result.current.handleOp({ op: 'addWidget', widgetType: 'text' }));
		const wId = result.current.state.selectedId!;
		act(() => result.current.handleOp({ op: 'reparent', id: wId, containerId: colId }));
		const col2 = result.current.state.monitor.root.children.find((c) => c.id === colId)!;
		expect(isContainer(col2) && col2.children.map((c) => c.id)).toContain(wId);
		act(() => result.current.handleOp({ op: 'distributeEvenly', containerId: colId }));
		const col3 = result.current.state.monitor.root.children.find((c) => c.id === colId)!;
		expect(isContainer(col3) && col3.children.every((c) => isLeaf(c) && c.basis)).toBe(true);
	});

	it('dropWidget / addBeside place containers/widgets next to a target', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.handleOp({ op: 'addContainer', kind: 'col' }));
		const colId = result.current.state.selectedId!;
		// dropWidget into the col.
		act(() =>
			result.current.handleOp({ op: 'dropWidget', containerId: colId, widgetType: 'text' })
		);
		const dropped = result.current.state.selectedId!;
		const col = result.current.state.monitor.root.children.find((c) => c.id === colId)!;
		expect(isContainer(col) && col.children.map((c) => c.id)).toContain(dropped);

		// addBeside the col → a sibling under the root.
		act(() => result.current.handleOp({ op: 'addBeside', id: colId, kind: 'row' }));
		const besideId = result.current.state.selectedId!;
		expect(result.current.state.monitor.root.children.map((c) => c.id)).toContain(besideId);
	});

	it('patchGroup edits a group; replaceNode swaps a node wholesale', () => {
		const { result } = renderModel();
		act(() => result.current.handleOp({ op: 'addWidget', widgetType: 'text' }));
		const id = result.current.state.selectedId!;
		act(() => result.current.handleOp({ op: 'makeWidget', id }));
		const grpId = result.current.state.selectedId!;
		act(() => result.current.handleOp({ op: 'patchGroup', id: grpId, patch: { name: 'grpname' } }));
		const grp = result.current.state.monitor.root.children.find((c) => c.id === grpId)!;
		expect(isLeaf(grp) && isGroup(grp.unit) && grp.unit.name).toBe('grpname');

		// replaceNode swaps the group leaf for a fresh primitive leaf at the same id.
		const replacement = leaf(createWidget('text', grpId));
		act(() => result.current.handleOp({ op: 'replaceNode', id: grpId, node: replacement }));
		const swapped = result.current.state.monitor.root.children.find((c) => c.id === grpId)!;
		expect(isLeaf(swapped) && isGroup(swapped.unit)).toBe(false);
	});

	it('endDefEdit via handleOp folds the open def back', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		act(() => result.current.dispatch({ type: 'newWidget' }));
		expect(result.current.state.editingDefId).not.toBeNull();
		act(() => result.current.handleOp({ op: 'endDefEdit' }));
		expect(result.current.state.editingDefId).toBeNull();
	});
});

describe('reducer fallback', () => {
	it('an unknown action type returns the state unchanged (same reference)', () => {
		const { result } = renderHook(() => useEditorModel(true, []));
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'nope' } as never));
		expect(result.current.state).toBe(before);
	});
});

describe('hook identity', () => {
	it('seeds the monitor with the demo floating leaves and a fresh empty root', () => {
		const seed = [leaf(createWidget('text', 'seed-1'))];
		const { result } = renderHook(() => useEditorModel(false, seed));
		expect(result.current.state.studio).toBe(false);
		expect(result.current.state.monitor.floating.map((l) => l.id)).toEqual(['seed-1']);
		expect(result.current.state.monitor.root.children).toEqual([]);
	});

	it('exposes a stable handleOp / commitOp / mutateNoSave across re-renders', () => {
		const { result, rerender } = renderHook(() => useEditorModel(true, []));
		const first = {
			handleOp: result.current.handleOp,
			commitOp: result.current.commitOp,
			mutateNoSave: result.current.mutateNoSave
		};
		rerender();
		expect(result.current.handleOp).toBe(first.handleOp);
		expect(result.current.commitOp).toBe(first.commitOp);
		expect(result.current.mutateNoSave).toBe(first.mutateNoSave);
	});
});
