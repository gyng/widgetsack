// useDefEditor is the studio-bar/list-side wrapper around the def-edit reducer: every "open a
// widget in the designer" path FOLDS any open def first (so the reducer's re-entry guard never
// blocks switching), then dispatches the mode action; rename/delete wrap handleOp with the
// window prompt/confirm/alert dialogs. The reducer itself is tested in useEditorModel.test.ts —
// here we assert this hook's orchestration (which action fires, in what order, with what guards)
// by spying on the injected dispatch / handleOp and stubbing the window dialogs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDefEditor } from './useDefEditor';
import type { EditorState } from './types';
import { container, emptyRoot, group, leaf, type MonitorLayout } from '../../core/layoutTree';
import { createWidget } from '../../core/widget';

// A minimal EditorState — only the fields defInUse() actually reads (monitor / editingDefId /
// savedMonitor) need to be real; the rest are filled to satisfy the type.
function makeState(monitor: MonitorLayout, over: Partial<EditorState> = {}): EditorState {
	return {
		monitor,
		library: { version: 1, defs: [] },
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
		studio: true,
		...over
	};
}

const emptyMonitor = (): MonitorLayout => ({ root: emptyRoot(), floating: [] });

// A monitor whose flow tree contains one group leaf that instantiates `defId` (makes defInUse true).
function monitorUsing(defId: string): MonitorLayout {
	const g = group('g1', { w: 100, h: 50 }, leaf(createWidget('text', 'g1-child')), { def: defId });
	return { root: container('root', 'col', [leaf(g)]), floating: [] };
}

type Deps = Parameters<typeof useDefEditor>[0];

// Render the hook with spy dispatch / handleOp and a mutable stateRef. Returns the hook result, the
// spies, and a rerender that lets a test flip editingDefId / previewing (the hook reads them via refs).
function setup(init: Partial<Deps> = {}) {
	const dispatch = vi.fn();
	const handleOp = vi.fn();
	const stateRef: React.RefObject<EditorState> = { current: makeState(emptyMonitor()) };
	const base: Deps = {
		editingDefId: null,
		previewing: false,
		stateRef,
		dispatch,
		handleOp,
		...init
	};
	const r = renderHook((props: Deps) => useDefEditor(props), { initialProps: base });
	return { ...r, dispatch, handleOp, stateRef, base };
}

let prompt: ReturnType<typeof vi.spyOn>;
let confirm: ReturnType<typeof vi.spyOn>;
let alert: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
	confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
	alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('foldOpenDef', () => {
	it('discards a read-only preview via endPreview', () => {
		const { result, dispatch } = setup({ previewing: true });
		act(() => result.current.foldOpenDef());
		expect(dispatch).toHaveBeenCalledWith({ type: 'endPreview' });
	});

	it('folds a real def edit via endDefEdit', () => {
		const { result, dispatch } = setup({ editingDefId: 'd1' });
		act(() => result.current.foldOpenDef());
		expect(dispatch).toHaveBeenCalledWith({ type: 'endDefEdit' });
	});

	it('preview wins over an open def edit (only endPreview fires)', () => {
		const { result, dispatch } = setup({ previewing: true, editingDefId: 'd1' });
		act(() => result.current.foldOpenDef());
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledWith({ type: 'endPreview' });
	});

	it('does nothing when neither previewing nor editing', () => {
		const { result, dispatch } = setup();
		act(() => result.current.foldOpenDef());
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('reads the LATEST previewing/editingDefId via refs after a rerender', () => {
		const { result, rerender, dispatch, base } = setup();
		// Initially neither flag is set → no-op.
		act(() => result.current.foldOpenDef());
		expect(dispatch).not.toHaveBeenCalled();
		// Flip editingDefId on a rerender; the stable callback must observe the new value.
		rerender({ ...base, editingDefId: 'd9' });
		act(() => result.current.foldOpenDef());
		expect(dispatch).toHaveBeenLastCalledWith({ type: 'endDefEdit' });
	});
});

describe('open / new / clone / template entry points fold first then dispatch', () => {
	it('startNewWidget folds the open def then dispatches newWidget (in that order)', () => {
		const { result, dispatch } = setup({ editingDefId: 'd1' });
		act(() => result.current.startNewWidget());
		expect(dispatch.mock.calls.map((c) => c[0])).toEqual([
			{ type: 'endDefEdit' },
			{ type: 'newWidget' }
		]);
	});

	it('openExistingDef folds then enters def-edit on the id', () => {
		const { result, dispatch } = setup({ previewing: true });
		act(() => result.current.openExistingDef('def-7'));
		expect(dispatch.mock.calls.map((c) => c[0])).toEqual([
			{ type: 'endPreview' },
			{ type: 'enterDefEdit', defId: 'def-7' }
		]);
	});

	it('openExistingDef is a guarded no-op for an empty id (no fold, no enter)', () => {
		const { result, dispatch } = setup({ editingDefId: 'd1' });
		act(() => result.current.openExistingDef(''));
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('cloneDefToEdit folds then dispatches cloneDef', () => {
		const { result, dispatch } = setup({ editingDefId: 'd1' });
		act(() => result.current.cloneDefToEdit('src'));
		expect(dispatch.mock.calls.map((c) => c[0])).toEqual([
			{ type: 'endDefEdit' },
			{ type: 'cloneDef', defId: 'src' }
		]);
	});

	it('newFromTemplate folds then dispatches newFromTemplate', () => {
		const { result, dispatch } = setup();
		act(() => result.current.newFromTemplate('clock-jp'));
		expect(dispatch).toHaveBeenCalledWith({ type: 'newFromTemplate', templateId: 'clock-jp' });
	});

	it('previewTemplate folds then dispatches previewTemplate', () => {
		const { result, dispatch } = setup({ editingDefId: 'd1' });
		act(() => result.current.previewTemplate('clock-jp'));
		expect(dispatch.mock.calls.map((c) => c[0])).toEqual([
			{ type: 'endDefEdit' },
			{ type: 'previewTemplate', templateId: 'clock-jp' }
		]);
	});
});

describe('preview banner buttons (no fold)', () => {
	it('clonePreview dispatches clonePreview without folding', () => {
		const { result, dispatch } = setup({ previewing: true });
		act(() => result.current.clonePreview());
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledWith({ type: 'clonePreview' });
	});

	it('closePreview dispatches endPreview', () => {
		const { result, dispatch } = setup({ previewing: true });
		act(() => result.current.closePreview());
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledWith({ type: 'endPreview' });
	});
});

describe('renameWidget (prompt)', () => {
	it('renames via handleOp with the trimmed prompt value', () => {
		prompt.mockReturnValue('  Fresh Name  ');
		const { result, handleOp } = setup();
		act(() => result.current.renameWidget('d1', 'Old'));
		expect(prompt).toHaveBeenCalledWith('Rename widget:', 'Old');
		expect(handleOp).toHaveBeenCalledWith({ op: 'renameDef', defId: 'd1', name: 'Fresh Name' });
	});

	it('is a no-op when the prompt is cancelled (null)', () => {
		prompt.mockReturnValue(null);
		const { result, handleOp } = setup();
		act(() => result.current.renameWidget('d1', 'Old'));
		expect(handleOp).not.toHaveBeenCalled();
	});

	it('is a no-op for a blank / whitespace-only name', () => {
		prompt.mockReturnValue('   ');
		const { result, handleOp } = setup();
		act(() => result.current.renameWidget('d1', 'Old'));
		expect(handleOp).not.toHaveBeenCalled();
	});
});

describe('deleteWidget (in-use guard + confirm)', () => {
	it('refuses to delete a def that is placed on a layout (alert, no handleOp)', () => {
		const stateRef: React.RefObject<EditorState> = { current: makeState(monitorUsing('used')) };
		const { result, handleOp } = setup({ stateRef });
		act(() => result.current.deleteWidget('used', 'My Widget'));
		expect(alert).toHaveBeenCalledTimes(1);
		expect(alert.mock.calls[0][0]).toContain('My Widget');
		expect(handleOp).not.toHaveBeenCalled();
	});

	it('is a no-op when the confirm dialog is declined', () => {
		confirm.mockReturnValue(false);
		const { result, handleOp } = setup(); // empty monitor → not in use
		act(() => result.current.deleteWidget('free', 'Spare'));
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(handleOp).not.toHaveBeenCalled();
	});

	it('deletes an unused, confirmed def via handleOp (no fold when it is not being edited)', () => {
		confirm.mockReturnValue(true);
		const { result, handleOp, dispatch } = setup({ editingDefId: 'other' });
		act(() => result.current.deleteWidget('free', 'Spare'));
		expect(handleOp).toHaveBeenCalledWith({ op: 'deleteDef', defId: 'free' });
		// editingDefId !== the deleted id → no foldOpenDef dispatch.
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('folds the open def first when deleting the def currently being designed', () => {
		confirm.mockReturnValue(true);
		// The deleted def is the one being edited → deleteWidget folds (endDefEdit) BEFORE deleteDef so
		// the reducer's deleteDef isn't blocked by the open scope.
		const { result, handleOp, dispatch } = setup({ editingDefId: 'self' });
		act(() => result.current.deleteWidget('self', 'Self'));
		expect(dispatch).toHaveBeenCalledWith({ type: 'endDefEdit' });
		expect(handleOp).toHaveBeenCalledWith({ op: 'deleteDef', defId: 'self' });
	});
});

describe('callback stability', () => {
	it('keeps every wrapper identity stable across a rerender (deps are dispatch/handleOp/stateRef)', () => {
		const { result, rerender, base } = setup();
		const first = { ...result.current };
		rerender({ ...base });
		for (const key of Object.keys(first) as (keyof typeof first)[]) {
			expect(result.current[key]).toBe(first[key]);
		}
	});
});
