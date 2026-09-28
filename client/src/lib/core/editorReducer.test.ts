import { editingDefinitionId, definitionBaseline } from './editorMode';
import { describe, it, expect } from 'vitest';
import { editorReducer, initialEditorState, type Action, type Patch } from './editorReducer';
import type { EditorState } from './editorState';
import { emptyRoot } from './layoutTree';
import { container, isLeaf, leaf, type Library, type MonitorLayout } from './layoutTree';
import { createWidget } from './widget';

// A tiny monitor with one docked text widget under the root (handy for `load` / baseline fixtures).
function oneWidgetMonitor(id = 'w-fix'): MonitorLayout {
	const root = container('root', 'col', [leaf(createWidget('text', id))], { align: 'stretch' });
	return { root, floating: [] };
}

const templateDefinition = {
	id: 'template',
	name: 'Template',
	size: { w: 200, h: 100 },
	child: leaf(createWidget('text', 'template-child'))
};
const act = (run: () => void) => run();
function createModel() {
	let state = initialEditorState(true, { root: emptyRoot(), floating: [] });
	const dispatch = (action: Action) => {
		state = editorReducer(state, action);
	};
	return {
		result: {
			get current() {
				return {
					state,
					dispatch,
					commitOp: (run: (s: EditorState) => Patch, coalesceKey?: string) =>
						dispatch({ type: 'op', run, commit: true, coalesceKey, at: 0 }),
					mutateNoSave: (run: (s: EditorState) => Patch) =>
						dispatch({ type: 'op', run, commit: false })
				};
			}
		}
	};
}

describe('editor reducer', () => {
	it('select sets selectedId and collapses any marquee to the single primary', () => {
		const { result } = createModel();
		act(() => result.current.dispatch({ type: 'setSelectedIds', ids: ['a', 'b'], primary: 'a' }));
		expect(result.current.state.selectedIds).toEqual(['a', 'b']);

		act(() => result.current.dispatch({ type: 'select', id: 'c' }));
		expect(result.current.state.selectedId).toBe('c');
		// syncPrimary collapses the stale marquee down to just the new primary.
		expect(result.current.state.selectedIds).toEqual(['c']);
		expect(result.current.state.lastPrimary).toBe('c');
	});

	it('select with id already the primary is a no-op for the marquee set', () => {
		const { result } = createModel();
		act(() => result.current.dispatch({ type: 'setSelectedIds', ids: ['a', 'b'], primary: 'a' }));
		// selecting the SAME id as the current primary leaves selectedId === lastPrimary, so syncPrimary
		// bails early and the marquee set survives.
		act(() => result.current.dispatch({ type: 'select', id: 'a' }));
		expect(result.current.state.selectedIds).toEqual(['a', 'b']);
	});

	it('selectClick sets both selectedId and selectedIds and marks them synced', () => {
		const { result } = createModel();
		act(() => result.current.dispatch({ type: 'setSelectedIds', ids: ['a', 'b'], primary: 'a' }));
		act(() => result.current.dispatch({ type: 'selectClick', id: 'z' }));
		const s = result.current.state;
		expect(s.selectedId).toBe('z');
		expect(s.selectedIds).toEqual(['z']);
		expect(s.lastPrimary).toBe('z');
	});

	it('setSelectedIds is authoritative (set + primary) and survives a follow-up no-op sync', () => {
		const { result } = createModel();
		act(() =>
			result.current.dispatch({ type: 'setSelectedIds', ids: ['x', 'y', 'z'], primary: 'y' })
		);
		const s = result.current.state;
		expect(s.selectedIds).toEqual(['x', 'y', 'z']);
		expect(s.selectedId).toBe('y');
		expect(s.lastPrimary).toBe('y');
	});

	it('commitOp applies the patch, records undo, and bumps saveSeq', () => {
		const { result } = createModel();
		const seq0 = result.current.state.saveSeq;
		act(() => result.current.commitOp((s) => ({ monitor: { ...s.monitor, floating: [] } })));
		// Even a no-op-shaped patch bumps saveSeq (the persistence effect fires on the seq, the undo
		// recorder dedupes by reference).
		expect(result.current.state.saveSeq).toBe(seq0 + 1);
	});

	it('a commit with history enabled but no anchor snapshot self-anchors (lastSnap ?? snap)', () => {
		const { result } = createModel();
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
		const { result } = createModel();
		const seq0 = result.current.state.saveSeq;
		act(() =>
			result.current.mutateNoSave((s) => ({ selectedId: 'transient', monitor: s.monitor }))
		);
		expect(result.current.state.selectedId).toBe('transient');
		expect(result.current.state.saveSeq).toBe(seq0);
		expect(result.current.state.undoStack).toEqual([]);
	});

	it('an op patch that sets selectedId (without selectedIds) collapses the marquee', () => {
		const { result } = createModel();
		act(() => result.current.dispatch({ type: 'setSelectedIds', ids: ['a', 'b'], primary: 'a' }));
		act(() => result.current.mutateNoSave(() => ({ selectedId: 'solo' })));
		expect(result.current.state.selectedIds).toEqual(['solo']);
	});

	it('an op patch that sets selectedIds is authoritative (the set is NOT collapsed)', () => {
		const { result } = createModel();
		act(() =>
			result.current.mutateNoSave(() => ({ selectedId: 'p', selectedIds: ['p', 'q', 'r'] }))
		);
		expect(result.current.state.selectedIds).toEqual(['p', 'q', 'r']);
	});

	it('plain patch action applies + syncs primary without committing', () => {
		const { result } = createModel();
		const seq0 = result.current.state.saveSeq;
		act(() => result.current.dispatch({ type: 'patch', patch: { selectedId: 'pp' } }));
		expect(result.current.state.selectedId).toBe('pp');
		expect(result.current.state.selectedIds).toEqual(['pp']); // collapsed
		expect(result.current.state.saveSeq).toBe(seq0);
	});

	it('undo on an empty stack is a no-op (same state reference)', () => {
		const { result } = createModel();
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'undo' }));
		expect(result.current.state).toBe(before);
	});

	it('keeps the global inherit-theme separate in an unlocked baseline', () => {
		const { result } = createModel();
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
		const { result } = createModel();
		act(() => result.current.dispatch({ type: 'newWidget', id: 'def-1', name: 'widget' }));
		expect(editingDefinitionId(result.current.state.mode)).not.toBeNull();
		act(() => result.current.dispatch({ type: 'setBaseline' }));
		expect(definitionBaseline(result.current.state.mode)).toBe(result.current.state.monitor);
	});

	it('newWidget appends an empty def, enters def-edit, and stashes the real monitor', () => {
		const { result } = createModel();
		const realMonitor = result.current.state.monitor;
		act(() => result.current.dispatch({ type: 'newWidget', id: 'def-2', name: 'widget' }));
		const s = result.current.state;
		expect(s.library?.defs).toHaveLength(1);
		expect(editingDefinitionId(s.mode)).toBe(s.library!.defs[0].id);
		expect(s.mode.kind === 'layout' ? null : s.mode.desktop).toBe(realMonitor); // the live layout is preserved untouched
		expect(definitionBaseline(s.mode)).toBe(s.monitor); // scoped monitor as the def-edit baseline
		expect(s.selectedId).toBeNull();
		expect(s.undoStack).toEqual([]); // history reset on entering the scope
	});

	it('newWidget is refused while already editing a def (would orphan savedMonitor)', () => {
		const { result } = createModel();
		act(() => result.current.dispatch({ type: 'newWidget', id: 'def-3', name: 'widget' }));
		const firstDefId = editingDefinitionId(result.current.state.mode);
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'newWidget', id: 'def-4', name: 'widget' }));
		expect(result.current.state).toBe(before); // unchanged
		expect(editingDefinitionId(result.current.state.mode)).toBe(firstDefId);
		expect(result.current.state.library?.defs).toHaveLength(1);
	});

	it('cloneDef duplicates an existing def (-copy) and enters def-edit on the copy', () => {
		const { result } = createModel();
		// Seed a library def, then leave def-edit so a clone is allowed.
		act(() => result.current.dispatch({ type: 'newWidget', id: 'def-5', name: 'widget' }));
		const srcId = editingDefinitionId(result.current.state.mode)!;
		act(() => result.current.dispatch({ type: 'endDefEdit' }));

		act(() => result.current.dispatch({ type: 'cloneDef', id: 'def-copy', defId: srcId }));
		const s = result.current.state;
		expect(s.library?.defs).toHaveLength(2);
		const copy = s.library!.defs.find((d) => d.id !== srcId)!;
		expect(copy.name.endsWith('-copy')).toBe(true);
		expect(editingDefinitionId(s.mode)).toBe(copy.id);
	});

	it('cloneDef is a no-op for an unknown def id', () => {
		const { result } = createModel();
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'cloneDef', id: 'def-copy', defId: 'nope' }));
		expect(result.current.state).toBe(before);
	});

	it('cloneDef is refused while already editing a def', () => {
		const { result } = createModel();
		act(() => result.current.dispatch({ type: 'newWidget', id: 'def-6', name: 'widget' }));
		const before = result.current.state;
		act(() =>
			result.current.dispatch({
				type: 'cloneDef',
				id: 'def-copy',
				defId: editingDefinitionId(before.mode)!
			})
		);
		expect(result.current.state).toBe(before);
	});

	it('newFromTemplate is refused while already editing a def', () => {
		const { result } = createModel();
		act(() => result.current.dispatch({ type: 'newWidget', id: 'def-7', name: 'widget' }));
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'newFromTemplate', definition: templateDefinition }));
		expect(result.current.state).toBe(before);
	});

	it('enterDefEdit is refused while another def is already open', () => {
		const { result } = createModel();
		act(() => result.current.dispatch({ type: 'newWidget', id: 'def-8', name: 'widget' }));
		const open = editingDefinitionId(result.current.state.mode);
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'enterDefEdit', defId: 'whatever' }));
		expect(result.current.state).toBe(before);
		expect(editingDefinitionId(result.current.state.mode)).toBe(open);
	});

	it('enterDefEdit is a no-op for an unknown def id', () => {
		const { result } = createModel();
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'enterDefEdit', defId: 'nope' }));
		expect(result.current.state).toBe(before);
	});

	it('endDefEdit writes back only the edited def; other library defs pass through untouched', () => {
		const { result } = createModel();
		act(() => result.current.dispatch({ type: 'newWidget', id: 'def-9', name: 'widget' }));
		const firstId = editingDefinitionId(result.current.state.mode)!;
		act(() => result.current.dispatch({ type: 'endDefEdit' }));
		const firstDef = result.current.state.library!.defs.find((d) => d.id === firstId)!;
		act(() => result.current.dispatch({ type: 'newWidget', id: 'def-10', name: 'widget' })); // a second def, now being edited
		act(() => result.current.dispatch({ type: 'endDefEdit' }));
		const s = result.current.state;
		expect(s.library?.defs).toHaveLength(2);
		expect(s.library?.defs.find((d) => d.id === firstId)).toBe(firstDef); // same object: untouched
	});

	it('endDefEdit is a no-op when not editing a def', () => {
		const { result } = createModel();
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'endDefEdit' }));
		expect(result.current.state).toBe(before);
	});

	it('newFromTemplate without a resolved definition is a no-op', () => {
		const { result } = createModel();
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'newFromTemplate', definition: null }));
		expect(result.current.state).toBe(before);
	});

	it('newFromTemplate of a LEAF-rooted template wraps the leaf in a scoped col root', () => {
		// A template tree can be a single leaf (not a container); scopedMonitorFromDef must
		// synthesize a col root around it so the def editor has a container to edit.
		const { result } = createModel();
		act(() => result.current.dispatch({ type: 'newFromTemplate', definition: templateDefinition }));
		const s = result.current.state;
		expect(editingDefinitionId(s.mode)).not.toBeNull();
		expect(s.monitor.root.kind).toBe('col');
		expect(s.monitor.root.id).toBe(`${editingDefinitionId(s.mode)}__root`);
		// The def itself keeps the raw leaf child (the synthesized root is only the EDITING scope).
		const def = s.library!.defs.find((d) => d.id === editingDefinitionId(s.mode))!;
		expect(isLeaf(def.child)).toBe(true);
	});

	it('load bulk-applies the supplied patch', () => {
		const { result } = createModel();
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
		const { result } = createModel();
		act(() => result.current.dispatch({ type: 'setTheme', name: 'builtin:solarized' }));
		expect(result.current.state.selectedTheme).toBe('builtin:solarized');
	});

	it('replaceMonitor swaps the monitor wholesale (no commit)', () => {
		const { result } = createModel();
		const seq0 = result.current.state.saveSeq;
		const mon = oneWidgetMonitor('rep');
		act(() => result.current.dispatch({ type: 'replaceMonitor', monitor: mon }));
		expect(result.current.state.monitor).toBe(mon);
		expect(result.current.state.saveSeq).toBe(seq0);
	});

	it('an unknown action type returns the state unchanged (same reference)', () => {
		const { result } = createModel();
		const before = result.current.state;
		act(() => result.current.dispatch({ type: 'nope' } as never));
		expect(result.current.state).toBe(before);
	});
});

it('replays a prepared definition action deterministically without mutating the input', () => {
	const state = initialEditorState(true, { root: emptyRoot(), floating: [] });
	const action = { type: 'newWidget', id: 'def-fixed', name: 'widget-fixed' } as const;
	const first = editorReducer(state, action);
	expect(editorReducer(state, action)).toEqual(first);
	expect(first.library?.defs[0]).toMatchObject({
		id: 'def-fixed',
		name: 'widget-fixed',
		child: { id: 'def-fixed__root' }
	});
	expect(state.mode.kind).toBe('layout');
	expect(state.library).toBeUndefined();
});
