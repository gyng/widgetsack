// Def editor (widget designer) entry points, extracted from Canvas: every "open a widget in the
// designer" path folds any open def first (foldOpenDef) so the reducer's re-entry guard never
// blocks switching widgets from the list while one is already open. The def-edit MODE itself
// (enterDefEdit / endDefEdit / preview) lives in the editor model's reducer — this hook is just
// the studio-bar/list-side wrappers plus the rename/delete prompts around handleOp.
import { useCallback, useEffect, useRef } from 'react';
import type { LayoutOp } from '../ops';
import { defInUse, type EditorModel } from './useEditorModel';
import type { EditorState } from './types';

type Deps = {
	editingDefId: string | null;
	previewing: boolean;
	/** The Canvas's live-state mirror (deleteWidget's in-use check reads it synchronously). */
	stateRef: React.RefObject<EditorState>;
	dispatch: EditorModel['dispatch'];
	handleOp: (op: LayoutOp) => void;
};

export type DefEditor = {
	/** Fold any open def: a read-only preview is discarded; a real def edit is folded back. */
	foldOpenDef: () => void;
	startNewWidget: () => void;
	openExistingDef: (defId: string) => void;
	cloneDefToEdit: (defId: string) => void;
	newFromTemplate: (templateId: string) => void;
	/** Clicking a template only PREVIEWS it (read-only); Clone (or the banner) clones it. */
	previewTemplate: (templateId: string) => void;
	clonePreview: () => void;
	closePreview: () => void;
	renameWidget: (defId: string, current: string) => void;
	deleteWidget: (defId: string, name: string) => void;
};

export function useDefEditor({
	editingDefId,
	previewing,
	stateRef,
	dispatch,
	handleOp
}: Deps): DefEditor {
	// Latest values for the stable callbacks (read in event handlers — no stale closure). Mirrored in
	// a commit effect (not during render); the callbacks only read these later, from user actions.
	const editingDefIdRef = useRef(editingDefId);
	const previewingRef = useRef(previewing);
	useEffect(() => {
		editingDefIdRef.current = editingDefId;
		previewingRef.current = previewing;
	});

	const foldOpenDef = useCallback(() => {
		// A read-only preview is discarded (endPreview); a real def edit is folded back (endDefEdit).
		if (previewingRef.current) dispatch({ type: 'endPreview' });
		else if (editingDefIdRef.current != null) dispatch({ type: 'endDefEdit' });
	}, [dispatch]);
	// Create a brand-new empty def + a floating instance, then enter the def editor (one dispatch).
	const startNewWidget = useCallback(() => {
		foldOpenDef();
		dispatch({ type: 'newWidget' });
	}, [foldOpenDef, dispatch]);
	const openExistingDef = useCallback(
		(defId: string) => {
			if (!defId) return;
			foldOpenDef();
			dispatch({ type: 'enterDefEdit', defId });
		},
		[foldOpenDef, dispatch]
	);
	const cloneDefToEdit = useCallback(
		(defId: string) => {
			foldOpenDef();
			dispatch({ type: 'cloneDef', defId });
		},
		[foldOpenDef, dispatch]
	);
	const newFromTemplate = useCallback(
		(templateId: string) => {
			foldOpenDef();
			dispatch({ type: 'newFromTemplate', templateId });
		},
		[foldOpenDef, dispatch]
	);
	// Clicking a template only PREVIEWS it (read-only); the Clone button (or the banner) clones it.
	const previewTemplate = useCallback(
		(templateId: string) => {
			foldOpenDef();
			dispatch({ type: 'previewTemplate', templateId });
		},
		[foldOpenDef, dispatch]
	);
	const clonePreview = useCallback(() => dispatch({ type: 'clonePreview' }), [dispatch]);
	const closePreview = useCallback(() => dispatch({ type: 'endPreview' }), [dispatch]);
	// Rename a library widget (prompt). Works on any def, including the one being designed — the name
	// lives in the library, so renaming mid-edit just updates it (the banner reflects it live).
	const renameWidget = useCallback(
		(defId: string, current: string) => {
			const name = window.prompt('Rename widget:', current);
			if (name && name.trim()) handleOp({ op: 'renameDef', defId, name: name.trim() });
		},
		[handleOp]
	);
	// Delete a library widget from the list. A def placed on a layout can't be deleted (it would
	// orphan instances) — tell the user instead of silently no-op'ing. If it's the one being
	// designed, fold the def edit first so deleteDef isn't blocked.
	const deleteWidget = useCallback(
		(defId: string, name: string) => {
			if (defInUse(stateRef.current, defId)) {
				window.alert(
					`“${name}” is placed on a layout — remove those instances before deleting it.`
				);
				return;
			}
			if (!window.confirm(`Delete widget “${name}” from your library?`)) return;
			if (defId === editingDefIdRef.current) foldOpenDef();
			handleOp({ op: 'deleteDef', defId });
		},
		[stateRef, foldOpenDef, handleOp]
	);

	return {
		foldOpenDef,
		startNewWidget,
		openExistingDef,
		cloneDefToEdit,
		newFromTemplate,
		previewTemplate,
		clonePreview,
		closePreview,
		renameWidget,
		deleteWidget
	};
}
