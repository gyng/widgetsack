// The Canvas editor model (item 2): a useReducer holding {monitor, library, selection, theme,
// tokens, def-edit, undo/redo, manual-save baseline}. NEVER mutates state in place — the core
// layoutEdit ops already return new trees, so dirty-tracking + undo rely on reference equality
// (a snapshot is just the current references). Undo coalesces at the saveLayout COMMIT chokepoint:
// one undo step per drag, recorded only when monitor/library reference-changed since lastSnap.
//
// The op helpers (the old Svelte handleOp switch bodies) are pure `(state) => Patch` transforms in
// the sibling editorOps.ts; this file owns the reducer — grouped into delegated sub-reducers
// (selection / history / def-edit / load+misc) — the handleOp dispatch table, and the hook. A
// commit (the old `saveLayout()`) runs the recordHistory logic inline on the post-edit state and
// bumps `saveSeq`; the persistence hook watches `saveSeq` to write to disk (debounced in the
// studio, immediate on an overlay).
import { useCallback, useMemo, useReducer } from 'react';
import { DEFAULT_MONITOR } from '../../core/layout';
import {
	container,
	emptyRoot,
	isContainer,
	type Container,
	type Leaf,
	type Library,
	type MonitorLayout,
	type WidgetDef
} from '../../core/layoutTree';
import { collapseContainer } from '../../core/layoutEdit';
import { getTemplate } from '../../core/templates';
import type { LayoutOp } from '../ops';
import { clampTreeSpacing } from './spacingGuard';
import type { EditorState, Snap } from './types';
import {
	addBeside,
	addContainer,
	addDefParam,
	addWidget,
	addWidgetAt,
	bulkPatchConfig,
	bulkSetBasis,
	cfgNum,
	clearTokens,
	clearWidgetTokens,
	clone,
	deleteDef,
	defInUse,
	distributeEvenly,
	dock,
	dropWidgetInto,
	floatingLeafFrom,
	floatNode,
	freshIds,
	indent,
	insertTemplate,
	insertWidget,
	lookup,
	makeWidget,
	outdent,
	patchContainerOp,
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
	setSolvedForFloat,
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
	setSolvedForFloat,
	DEFAULT_MONITOR
};

// --- snapshot / history helpers (operate on a state slice) ----------------------------------

function snap(s: EditorState): Snap {
	return { monitor: s.monitor, library: s.library };
}

// Re-baseline history to the current layout (no undo entries across this point).
function resetHistoryPatch(next: EditorState): Patch {
	return { undoStack: [], redoStack: [], lastSnap: snap(next), historyReady: true };
}

// The commit point. If the layout changed since the last snapshot, push the previous snapshot for
// undo and clear the redo branch, then advance lastSnap. A no-op when nothing changed.
function recordHistory(next: EditorState): Patch {
	if (!next.historyReady) return {};
	if (
		next.lastSnap &&
		next.monitor === next.lastSnap.monitor &&
		next.library === next.lastSnap.library
	)
		return {};
	return {
		undoStack: [...next.undoStack, next.lastSnap ?? snap(next)].slice(-100),
		redoStack: [],
		lastSnap: snap(next)
	};
}

function setBaselinePatch(s: EditorState): Patch {
	return {
		savedBaseline: {
			monitor: s.monitor,
			library: s.library,
			theme: s.selectedTheme,
			themeLock: s.themeLock,
			globalTheme: s.themeLock ? s.selectedTheme : (s.globalTheme ?? ''),
			tokens: s.tokenOverrides
		},
		// While editing a def, re-anchor the def-edit baseline too, so a mid-def-edit Save clears the
		// dirty indicator (the next scoped edit re-dirties it). On load/normal save editingDefId is
		// null, so this is a no-op there.
		...(s.editingDefId != null ? { defEditBaseline: s.monitor } : {})
	};
}

// =============================================================================================
// The reducer. Mutating ops dispatch `{ type: 'op', run, commit }` where `run(state)` returns a
// patch; commit runs recordHistory + bumps saveSeq (the persistence chokepoint). Dedicated
// actions cover selection, undo/redo, def-edit, history reset, baseline, and load — grouped into
// the sub-reducers below by concern.
// =============================================================================================

type Action =
	| { type: 'op'; run: (s: EditorState) => Patch; commit: boolean }
	| { type: 'undo' }
	| { type: 'redo' }
	| { type: 'select'; id: string }
	| { type: 'selectClick'; id: string } // a plain click: collapses any marquee selection
	| { type: 'setSelectedIds'; ids: string[]; primary: string | null }
	| { type: 'enterDefEdit'; defId: string }
	| { type: 'newWidget' } // item 4: create an empty def + floating instance, then enter def-edit
	| { type: 'cloneDef'; defId: string } // duplicate a widget def + enter def-edit on the copy
	| { type: 'newFromTemplate'; templateId: string } // a new widget def seeded from a template
	| { type: 'previewTemplate'; templateId: string } // read-only preview (NOT cloned into the library)
	| { type: 'endPreview' } // leave a template preview, discarding it
	| { type: 'clonePreview' } // promote the previewed template into the library + keep editing it
	| { type: 'endDefEdit' }
	| { type: 'resetHistory' }
	| { type: 'setBaseline' }
	| { type: 'load'; patch: Patch } // bulk set after reloadLayout (then resetHistory + setBaseline)
	| { type: 'setTheme'; name: string } // mirror selectedTheme (applyTheme is a side-effect)
	| { type: 'setMonitorKey' } // switch-monitor reset (clear selection/menu handled outside)
	| { type: 'replaceMonitor'; monitor: MonitorLayout } // raw set (switchMonitor placeholder)
	| { type: 'revertToBaseline' } // Cancel / discard-on-switch: restore the saved baseline
	| { type: 'patch'; patch: Patch }; // a plain non-committing patch (selectedIds, etc.)

function commitPatch(next: EditorState): Patch {
	// next is the post-edit state; record undo then advance saveSeq so the persistence effect fires.
	const hist = recordHistory(next);
	return { ...hist, saveSeq: next.saveSeq + 1 };
}

// Port of Svelte's `$: syncSelectionPrimary(selectedId)` reactive: when an op changes selectedId
// without itself setting the multi-select set, collapse selectedIds to just the new primary (so a
// single-target op clears any marquee selection). If the patch SET selectedIds (marquee / template /
// group move / multi-delete), the set is authoritative and we only advance lastPrimary.
function syncPrimary(next: EditorState, patchSetSelectedIds: boolean): EditorState {
	if (next.selectedId === next.lastPrimary) return next;
	const lastPrimary = next.selectedId;
	if (patchSetSelectedIds) return { ...next, lastPrimary };
	return { ...next, lastPrimary, selectedIds: next.selectedId ? [next.selectedId] : [] };
}

// --- selection sub-reducer -------------------------------------------------------------------

type SelectionAction = Extract<Action, { type: 'select' | 'selectClick' | 'setSelectedIds' }>;

function reduceSelection(state: EditorState, action: SelectionAction): EditorState {
	switch (action.type) {
		case 'select':
			// A bare select (Outline/Inspector/menu) sets selectedId only → collapse the marquee.
			return syncPrimary({ ...state, selectedId: action.id }, false);
		case 'selectClick':
			// A plain canvas click: set both + mark synced so syncPrimary is a no-op.
			return { ...state, selectedId: action.id, selectedIds: [action.id], lastPrimary: action.id };
		case 'setSelectedIds':
			// Authoritative multi-select (marquee): set the set + primary, mark synced.
			return {
				...state,
				selectedIds: action.ids,
				selectedId: action.primary,
				lastPrimary: action.primary
			};
	}
}

// --- history sub-reducer (undo/redo/reset/baseline) -------------------------------------------

type HistoryAction = Extract<Action, { type: 'undo' | 'redo' | 'resetHistory' | 'setBaseline' }>;

function reduceHistory(state: EditorState, action: HistoryAction): EditorState {
	switch (action.type) {
		case 'undo': {
			if (!state.undoStack.length) return state;
			const redoStack = [...state.redoStack, snap(state)];
			const prev = state.undoStack[state.undoStack.length - 1];
			const undoStack = state.undoStack.slice(0, -1);
			// monitor/library revert; lastSnap=prev so the commit records nothing; then commit (save).
			let next: EditorState = {
				...state,
				monitor: prev.monitor,
				library: prev.library,
				undoStack,
				redoStack,
				lastSnap: prev
			};
			next = { ...next, ...commitPatch(next) };
			return next;
		}
		case 'redo': {
			if (!state.redoStack.length) return state;
			const undoStack = [...state.undoStack, snap(state)];
			const next0 = state.redoStack[state.redoStack.length - 1];
			const redoStack = state.redoStack.slice(0, -1);
			let next: EditorState = {
				...state,
				monitor: next0.monitor,
				library: next0.library,
				undoStack,
				redoStack,
				lastSnap: next0
			};
			next = { ...next, ...commitPatch(next) };
			return next;
		}
		case 'resetHistory':
			return { ...state, ...resetHistoryPatch(state) };
		case 'setBaseline':
			return { ...state, ...setBaselinePatch(state) };
	}
}

// --- def-edit sub-reducer (the widget designer mode switches) ----------------------------------

// The scoped monitor for designing/previewing `def`: a clone of its child as the root, with any
// pad/gap too big for the def's canvas self-healed (see spacingGuard.clampTreeSpacing).
function scopedMonitorFromDef(def: WidgetDef): MonitorLayout {
	const rawRoot: Container = isContainer(def.child)
		? (clone(def.child) as Container)
		: container(`${def.id}__root`, 'col', [clone(def.child)], { align: 'stretch' });
	return { root: clampTreeSpacing(rawRoot, def.size) as Container, floating: [] };
}

// Build a fresh WidgetDef from a template id: the template's flow TREE (defaults baked, ids
// remapped) becomes the def child at the template's declared size, and the template's ParamSpecs
// become the def's params — so a cloned clock still switches 12/24-hour per instance, instead of
// the options being silently dropped/baked. Shared by newFromTemplate (clone into the library) and
// previewTemplate (read-only preview, not stored).
function templateDef(templateId: string): WidgetDef | null {
	const t = getTemplate(templateId);
	if (!t) return null;
	return {
		id: `def-${rand()}`,
		name: t.name,
		size: t.size,
		child: freshIds(t.tree()),
		...(t.params ? { params: clone(t.params) } : {})
	};
}

// Add a freshly-built def to the library, then enter the def editor scoped to it. Shared by
// newWidget / cloneDef / newFromTemplate. Does NOT drop an instance onto the live monitor —
// designing a widget shouldn't place it on the layout; the whole library is persisted regardless
// (usePersistence writes every def), and the user instantiates it via the Inspector library
// palette. Assumes the caller already refused re-entry while another def is open (would orphan
// savedMonitor).
function enterNewDef(state: EditorState, def: WidgetDef): EditorState {
	const library: Library = {
		version: state.library?.version ?? 1,
		defs: [...(state.library?.defs ?? []), def]
	};
	const scopedMonitor = scopedMonitorFromDef(def);
	const next: EditorState = {
		...state,
		library,
		savedMonitor: state.monitor, // preserve the REAL monitor untouched (no instance dropped)
		monitor: scopedMonitor,
		defEditBaseline: scopedMonitor,
		editingDefId: def.id,
		selectedId: null
	};
	return syncPrimary({ ...next, ...resetHistoryPatch(next) }, false);
}

type DefEditAction = Extract<
	Action,
	{
		type:
			| 'newWidget'
			| 'cloneDef'
			| 'newFromTemplate'
			| 'previewTemplate'
			| 'endPreview'
			| 'clonePreview'
			| 'enterDefEdit'
			| 'endDefEdit';
	}
>;

function reduceDefEdit(state: EditorState, action: DefEditAction): EditorState {
	switch (action.type) {
		case 'newWidget': {
			// Refuse to start a new def while already editing one (would orphan savedMonitor). The UI
			// folds the open def (endDefEdit) before starting a new one.
			if (state.editingDefId != null) return state;
			const defId = `def-${rand()}`;
			const def: WidgetDef = {
				id: defId,
				name: `widget-${rand()}`,
				size: { w: 200, h: 120 },
				child: container(`${defId}__root`, 'col', [], { align: 'stretch' })
			};
			return enterNewDef(state, def);
		}
		case 'cloneDef': {
			if (state.editingDefId != null) return state;
			const src = state.library?.defs.find((d) => d.id === action.defId);
			if (!src) return state;
			const defId = `def-${rand()}`;
			const def: WidgetDef = {
				id: defId,
				name: `${src.name}-copy`,
				size: { ...src.size },
				child: clone(src.child),
				...(src.css ? { css: src.css } : {}),
				...(src.params ? { params: src.params.map((p) => ({ ...p })) } : {})
			};
			return enterNewDef(state, def);
		}
		case 'newFromTemplate': {
			if (state.editingDefId != null) return state;
			const def = templateDef(action.templateId);
			return def ? enterNewDef(state, def) : state;
		}
		case 'previewTemplate': {
			// Read-only preview: scope to the template like a def edit, but DON'T add it to the library
			// (it lives in `previewDef`). The Clone button promotes it; Close discards it.
			if (state.editingDefId != null) return state; // the UI folds any open def/preview first
			const def = templateDef(action.templateId);
			if (!def) return state;
			const next: EditorState = {
				...state,
				savedMonitor: state.monitor,
				monitor: scopedMonitorFromDef(def),
				defEditBaseline: null,
				editingDefId: def.id,
				previewDef: def,
				selectedId: null
			};
			return syncPrimary({ ...next, ...resetHistoryPatch(next) }, false);
		}
		case 'endPreview': {
			if (!state.previewDef || !state.savedMonitor) return state;
			const next: EditorState = {
				...state,
				monitor: state.savedMonitor,
				savedMonitor: null,
				editingDefId: null,
				previewDef: null,
				selectedId: null
			};
			return syncPrimary({ ...next, ...resetHistoryPatch(next) }, false);
		}
		case 'clonePreview': {
			// Promote the previewed template into the library and keep editing it (now unlocked).
			if (!state.previewDef) return state;
			const def = state.previewDef;
			const library: Library = {
				version: state.library?.version ?? 1,
				defs: [...(state.library?.defs ?? []), def]
			};
			let next: EditorState = {
				...state,
				library,
				previewDef: null,
				defEditBaseline: state.monitor // a real def-edit baseline from here on
			};
			next = { ...next, ...commitPatch(next) }; // record + persist the new library def
			return next;
		}
		case 'enterDefEdit': {
			// Never re-enter while already designing — a nested enter would overwrite savedMonitor with
			// the scoped tree and lose the real monitor layout (the UI folds the open def first).
			if (state.editingDefId != null) return state;
			const def = state.library?.defs.find((d) => d.id === action.defId);
			if (!def) return state;
			// scopedMonitorFromDef self-heals oversized pad/gap for this widget's canvas — so opening a
			// def whose root was over-padded (e.g. copied from a full-monitor root) shows usable panes.
			const scopedMonitor = scopedMonitorFromDef(def);
			const next: EditorState = {
				...state,
				savedMonitor: state.monitor,
				monitor: scopedMonitor,
				defEditBaseline: scopedMonitor,
				editingDefId: action.defId,
				selectedId: null
			};
			return syncPrimary({ ...next, ...resetHistoryPatch(next) }, false);
		}
		case 'endDefEdit': {
			if (!state.editingDefId || !state.savedMonitor) return state;
			// syncEditingDef: write the scoped editing tree back onto its def.
			const child = state.monitor.root;
			const editingDefId = state.editingDefId;
			const library: Library | undefined = state.library
				? {
						...state.library,
						defs: state.library.defs.map((d) => (d.id === editingDefId ? { ...d, child } : d))
					}
				: state.library;
			let next: EditorState = {
				...state,
				library,
				monitor: state.savedMonitor,
				savedMonitor: null,
				defEditBaseline: null,
				editingDefId: null,
				selectedId: null
			};
			next = syncPrimary({ ...next, ...resetHistoryPatch(next) }, false);
			next = { ...next, ...commitPatch(next) }; // saveLayout()
			return next;
		}
	}
}

// --- load / persistence-adjacent sub-reducer ---------------------------------------------------

type LoadAction = Extract<
	Action,
	{ type: 'load' | 'setTheme' | 'replaceMonitor' | 'revertToBaseline' | 'setMonitorKey' }
>;

function reduceLoad(state: EditorState, action: LoadAction): EditorState {
	switch (action.type) {
		case 'load':
			return { ...state, ...action.patch };
		case 'setTheme':
			return { ...state, selectedTheme: action.name };
		case 'replaceMonitor':
			return { ...state, monitor: action.monitor };
		case 'revertToBaseline': {
			if (!state.savedBaseline) return state;
			const b = state.savedBaseline;
			return {
				...state,
				monitor: b.monitor,
				library: b.library,
				selectedTheme: b.theme,
				themeLock: b.themeLock,
				globalTheme: b.globalTheme,
				tokenOverrides: b.tokens,
				pendingExtras: []
			};
		}
		case 'setMonitorKey':
			return state;
	}
}

function editorReducer(state: EditorState, action: Action): EditorState {
	switch (action.type) {
		case 'op': {
			const patch = action.run(state);
			const setSelectedIds = 'selectedIds' in patch;
			let next = { ...state, ...patch };
			next = syncPrimary(next, setSelectedIds); // collapse the marquee unless the op set the set
			if (action.commit) next = { ...next, ...commitPatch(next) };
			return next;
		}
		case 'patch': {
			const setSelectedIds = 'selectedIds' in action.patch;
			return syncPrimary({ ...state, ...action.patch }, setSelectedIds);
		}
		case 'select':
		case 'selectClick':
		case 'setSelectedIds':
			return reduceSelection(state, action);
		case 'undo':
		case 'redo':
		case 'resetHistory':
		case 'setBaseline':
			return reduceHistory(state, action);
		case 'newWidget':
		case 'cloneDef':
		case 'newFromTemplate':
		case 'previewTemplate':
		case 'endPreview':
		case 'clonePreview':
		case 'enterDefEdit':
		case 'endDefEdit':
			return reduceDefEdit(state, action);
		case 'load':
		case 'setTheme':
		case 'replaceMonitor':
		case 'revertToBaseline':
		case 'setMonitorKey':
			return reduceLoad(state, action);
		default:
			return state;
	}
}

export type EditorModel = {
	state: EditorState;
	dispatch: React.Dispatch<Action>;
	// The Inspector/Outline/context-menu funnel: ports the Svelte handleOp switch verbatim.
	handleOp: (op: LayoutOp) => void;
	// Convenience wrappers the Canvas calls directly (drag/drop/marquee/keyboard paths).
	commitOp: (run: (s: EditorState) => Patch) => void; // mutate + saveLayout
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

const initial = (studio: boolean, seedMonitor: MonitorLayout): EditorState => ({
	monitor: seedMonitor,
	library: undefined,
	selectedId: null,
	selectedIds: [],
	lastPrimary: null,
	selectedTheme: '',
	themeLock: true, // default: one theme across all monitors (Settings unlocks per-monitor themes)
	globalTheme: '',
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
	studio
});

export function useEditorModel(studio: boolean, seedFloating: Leaf[]): EditorModel {
	const seedMonitor = useMemo<MonitorLayout>(
		() => ({ root: emptyRoot(), floating: seedFloating }),
		// seedFloating is computed once by the caller (demo seed); freeze it.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
		[]
	);
	const [state, dispatch] = useReducer(editorReducer, undefined, () =>
		initial(studio, seedMonitor)
	);

	const commitOp = useCallback(
		(run: (s: EditorState) => Patch) => dispatch({ type: 'op', run, commit: true }),
		[]
	);
	const mutateNoSave = useCallback(
		(run: (s: EditorState) => Patch) => dispatch({ type: 'op', run, commit: false }),
		[]
	);

	// The handleOp switch — ported VERBATIM. `break` cases mutate + saveLayout (commit:true);
	// `return` cases (select / editDef / endDefEdit) dispatch dedicated, non-saving actions.
	const handleOp = useCallback(
		(op: LayoutOp): void => {
			switch (op.op) {
				case 'select':
					dispatch({ type: 'select', id: op.id });
					return; // no save (selection isn't persisted)
				case 'addWidget':
					commitOp((s) => addWidget(s, op.widgetType));
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
					commitOp((s) => floatNode(s, op.id));
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
					commitOp((s) => patchUnit(s, op.id, op.patch));
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
			}
		},
		[commitOp]
	);

	return useMemo<EditorModel>(
		() => ({ state, dispatch, handleOp, commitOp, mutateNoSave }),
		[state, handleOp, commitOp, mutateNoSave]
	);
}
