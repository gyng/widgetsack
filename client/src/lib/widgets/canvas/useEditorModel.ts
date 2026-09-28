import { editorReducer, initialEditorState } from '../../core/editorReducer';
export { COALESCE_MS } from '../../core/editorReducer';
import { prepareEditorAction, type EditorAction } from './editorActions';
import type { EditorGeometry } from './editorOps';
// React adapter for the pure editor reducer. Fresh identities are prepared before dispatch;
// commit timestamps are supplied here for history coalescing.
import { useCallback, useMemo, useReducer } from 'react';
import { DEFAULT_MONITOR } from '../../core/layout';
import { emptyRoot, type Leaf, type MonitorLayout } from '../../core/layoutTree';
import { collapseContainer } from '../../core/layoutEdit';
import { getTemplate } from '../../core/templates';
import type { LayoutOp } from '../ops';
import type { EditorState } from './types';
import {
	addBeside,
	addContainer,
	addDefParam,
	addWidget,
	addWidgetAt,
	alignFloating,
	bulkPatchConfig,
	bulkSetBasis,
	cfgNum,
	clearTokens,
	clearWidgetTokens,
	clone,
	deleteDef,
	defInUse,
	distributeEvenly,
	distributeFloating,
	dock,
	dropWidgetInto,
	floatingLeafFrom,
	floatNode,
	indent,
	insertTemplate,
	insertWidget,
	lookup,
	makeWidget,
	outdent,
	patchContainerOp,
	patchFloating,
	patchGroup,
	patchUnit,
	rand,
	removeById,
	renameDef,
	reorder,
	reparentNode,
	replaceNodeOp,
	resetWidget,
	setBackground,
	setDefCss,
	setDefSize,
	setGridTracks,
	setLeafAlign,
	setLeafBox,
	setNodeBases,
	setNodeBasis,
	setToken,
	setTokens,
	setWidgetToken,
	splitNode,
	ungroupSelected,
	wrapLeafWith,
	type Patch
} from './editorOps';

// Stable public surface: the Canvas + the co-located tests import these from here (the ops module
// is an implementation detail of the model).
export {
	addWidget,
	addContainer,
	addBeside,
	splitNode,
	patchContainerOp,
	distributeEvenly,
	setGridTracks,
	floatNode,
	defInUse,
	bulkPatchConfig,
	bulkSetBasis,
	setWidgetToken,
	clearWidgetTokens,
	lookup,
	patchFloating,
	DEFAULT_MONITOR
};

export type EditorModel = {
	state: EditorState;
	dispatch: React.Dispatch<EditorAction>;
	// The Inspector/Outline/context-menu funnel: ports the Svelte handleOp switch verbatim.
	handleOp: (op: LayoutOp, geometry?: EditorGeometry) => void;
	// Convenience wrappers the Canvas calls directly (drag/drop/marquee/keyboard paths). An optional
	// `coalesceKey` folds a same-key burst (typing, key-repeat) into ONE undo step — see recordHistory.
	commitOp: (run: (s: EditorState) => Patch, coalesceKey?: string) => void; // mutate + saveLayout
	mutateNoSave: (run: (s: EditorState) => Patch) => void; // mutate, no save (transient onChange)
};

// Stable, module-level pure helpers the Canvas's drag/drop/menu closures call directly (they take
// the current state via the commitOp/mutateNoSave run argument, so no React identity churn).
export const editHelpers = {
	rand,
	clone,
	cfgNum,
	wrapLeafWith,
	floatingLeafFrom,
	removeById,
	makeWidget,
	getTemplate,
	setNodeBases, // splitter drag: set both children's fr in one mutateNoSave/commitOp run
	setGridTracks // grid-track splitter drag: set the two tracks' colFr/rowFr weights
};

export function useEditorModel(studio: boolean, seedFloating: Leaf[]): EditorModel {
	const seedMonitor = useMemo<MonitorLayout>(
		() => ({ root: emptyRoot(), floating: seedFloating }),
		// seedFloating is computed once by the caller (demo seed); freeze it.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
		[]
	);
	const [state, reduceAction] = useReducer(editorReducer, undefined, () =>
		initialEditorState(studio, seedMonitor)
	);

	const dispatch = useCallback(
		(action: EditorAction) => reduceAction(prepareEditorAction(action)),
		[]
	);

	const commitOp = useCallback(
		(run: (s: EditorState) => Patch, coalesceKey?: string) =>
			dispatch({ type: 'op', run, commit: true, coalesceKey, at: Date.now() }),
		[dispatch]
	);
	const mutateNoSave = useCallback(
		(run: (s: EditorState) => Patch) => dispatch({ type: 'op', run, commit: false }),
		[dispatch]
	);

	// The handleOp switch — ported VERBATIM. `break` cases mutate + saveLayout (commit:true);
	// `return` cases (select / editDef / endDefEdit) dispatch dedicated, non-saving actions.
	const handleOp = useCallback(
		(op: LayoutOp, geometry?: EditorGeometry): void => {
			switch (op.op) {
				case 'select':
					dispatch({ type: 'select', id: op.id });
					return; // no save (selection isn't persisted)
				case 'addWidget':
					commitOp((s) => addWidget(s, op.widgetType, geometry));
					return;
				case 'addWidgetAt':
					commitOp((s) => addWidgetAt(s, op.widgetType, op.x, op.y));
					return;
				case 'addContainer':
					commitOp((s) => addContainer(s, op.kind, op.containerId, op.index));
					return;
				case 'distributeEvenly':
					commitOp((s) => distributeEvenly(s, op.containerId));
					return;
				case 'addBeside':
					commitOp((s) => addBeside(s, op.id, op.kind));
					return;
				case 'split':
					commitOp((s) => splitNode(s, op.id, op.dir, op.cellIndex));
					return;
				case 'collapse':
					commitOp((s) => ({
						monitor: { ...s.monitor, root: collapseContainer(s.monitor.root, op.id) },
						selectedId: op.id
					}));
					return;
				case 'remove':
					commitOp((s) => removeById(s, op.id));
					return;
				case 'moveUp':
					commitOp((s) => reorder(s, op.id, -1));
					return;
				case 'moveDown':
					commitOp((s) => reorder(s, op.id, 1));
					return;
				case 'outdent':
					commitOp((s) => outdent(s, op.id));
					return;
				case 'indent':
					commitOp((s) => indent(s, op.id));
					return;
				case 'dock':
					commitOp((s) => dock(s, op.id));
					return;
				case 'float':
					commitOp((s) => floatNode(s, op.id, undefined, geometry?.solved));
					return;
				case 'makeWidget':
					commitOp((s) => makeWidget(s, op.id));
					return;
				case 'ungroup':
					commitOp((s) => ungroupSelected(s, op.id));
					return;
				case 'insertWidget':
					commitOp((s) => insertWidget(s, op.defId));
					return;
				case 'insertTemplate':
					commitOp((s) => insertTemplate(s, op.templateId, op.options));
					return;
				case 'renameDef':
					commitOp((s) => renameDef(s, op.defId, op.name));
					return;
				case 'deleteDef':
					commitOp((s) => deleteDef(s, op.defId));
					return;
				case 'addDefParam':
					commitOp((s) => addDefParam(s, op.defId, op.key, op.target));
					return;
				case 'editDef':
					dispatch({ type: 'enterDefEdit', defId: op.defId });
					return; // no save (just a mode switch)
				case 'endDefEdit':
					dispatch({ type: 'endDefEdit' });
					return;
				case 'setDefSize':
					commitOp((s) => setDefSize(s, op.defId, op.w, op.h));
					return;
				case 'patchGroup':
					commitOp((s) => patchGroup(s, op.id, op.patch));
					return;
				case 'setDefCss':
					commitOp((s) => setDefCss(s, op.defId, op.css));
					return;
				case 'setToken':
					commitOp((s) => setToken(s, op.key, op.value));
					return;
				case 'setTokens':
					commitOp((s) => setTokens(s, op.tokens));
					return;
				case 'clearTokens':
					commitOp((s) => clearTokens(s));
					return;
				case 'setBackground':
					commitOp((s) => setBackground(s, op.spec));
					return;
				case 'setWidgetToken':
					commitOp((s) => setWidgetToken(s, op.id, op.key, op.value));
					return;
				case 'clearWidgetTokens':
					commitOp((s) => clearWidgetTokens(s, op.id));
					return;
				case 'patchWidget':
					commitOp((s) => patchUnit(s, op.id, op.patch), op.coalesce);
					return;
				case 'setBasis':
					commitOp((s) => setNodeBasis(s, op.id, op.basis));
					return;
				case 'setLeafAlign':
					commitOp((s) => setLeafAlign(s, op.id, op.halign, op.valign));
					return;
				case 'setLeafBox':
					commitOp((s) => setLeafBox(s, op.id, op.field, op.value));
					return;
				case 'resetWidget':
					commitOp((s) => resetWidget(s, op.id));
					return;
				case 'patchContainer':
					commitOp((s) => patchContainerOp(s, op.id, op.patch));
					return;
				case 'dropWidget':
					commitOp((s) => dropWidgetInto(s, op.containerId, op.widgetType));
					return;
				case 'reparent':
					commitOp((s) => reparentNode(s, op.id, op.containerId));
					return;
				case 'replaceNode':
					commitOp((s) => replaceNodeOp(s, op.id, op.node));
					return;
				case 'alignSelected':
					commitOp((s) => alignFloating(s, op.ids, op.edge));
					return;
				case 'distributeSelected':
					commitOp((s) => distributeFloating(s, op.ids, op.axis));
					return;
			}
		},
		[commitOp, dispatch]
	);

	return useMemo<EditorModel>(
		() => ({ state, dispatch, handleOp, commitOp, mutateNoSave }),
		[state, dispatch, handleOp, commitOp, mutateNoSave]
	);
}
