import { desktopMonitor, editedLibrary } from './editorMode';
import {
	container,
	isContainer,
	type Container,
	type Library,
	type MonitorLayout,
	type WidgetDef
} from './layoutTree';
import { findNode } from './layoutEdit';
import { clampTreeSpacing } from './spacingGuard';
import type { EditorState, Snap } from './editorState';
export type Patch = Partial<EditorState>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// --- snapshot / history helpers (operate on a state slice) ----------------------------------

/** Same-key commits closer together than this fold into one undo step (a typing / key-repeat burst). */
export const COALESCE_MS = 600;

function snap(s: EditorState): Snap {
	return {
		monitor: s.monitor,
		library: s.library,
		pendingExtras: s.pendingExtras,
		tokenOverrides: s.tokenOverrides,
		selectedTheme: s.selectedTheme,
		themeLock: s.themeLock
	};
}

// Reference/value equality over every snapshot field (the ops return new objects on change).
function sameSnap(s: EditorState, t: Snap): boolean {
	return (
		s.monitor === t.monitor &&
		s.library === t.library &&
		s.pendingExtras === t.pendingExtras &&
		s.tokenOverrides === t.tokenOverrides &&
		s.selectedTheme === t.selectedTheme &&
		s.themeLock === t.themeLock
	);
}

// Restore a snapshot's fields onto the state (undo/redo).
function applySnap(s: EditorState, t: Snap): EditorState {
	return {
		...s,
		monitor: t.monitor,
		library: t.library,
		pendingExtras: t.pendingExtras,
		tokenOverrides: t.tokenOverrides,
		selectedTheme: t.selectedTheme,
		themeLock: t.themeLock
	};
}

// Re-baseline history to the current layout (no undo entries across this point).
function resetHistoryPatch(next: EditorState): Patch {
	return {
		undoStack: [],
		redoStack: [],
		lastSnap: snap(next),
		historyReady: true,
		lastCommit: null
	};
}

// The commit point. If anything in the snapshot changed since the last one, push the previous
// snapshot for undo and clear the redo branch, then advance lastSnap. A no-op when nothing changed.
// COALESCING: a commit carrying the same `coalesceKey` as the previous commit, within COALESCE_MS,
// is folded into that undo step — the stack's top entry (the state before the burst began) stays
// put and only lastSnap advances, so one Ctrl+Z undoes the whole typed word / held-arrow run.
function recordHistory(next: EditorState, coalesceKey?: string, at = 0): Patch {
	if (!next.historyReady) return {};
	if (next.lastSnap && sameSnap(next, next.lastSnap)) return {};
	const lastCommit = coalesceKey ? { key: coalesceKey, at } : null;
	const prev = next.lastCommit;
	if (coalesceKey && prev && prev.key === coalesceKey && at - prev.at < COALESCE_MS) {
		return { redoStack: [], lastSnap: snap(next), lastCommit };
	}
	return {
		undoStack: [...next.undoStack, next.lastSnap ?? snap(next)].slice(-100),
		redoStack: [],
		lastSnap: snap(next),
		lastCommit
	};
}

function setBaselinePatch(s: EditorState, current: EditorState = s): Patch {
	const library = editedLibrary(s);
	return {
		savedBaseline: {
			monitor: desktopMonitor(s),
			library,
			theme: s.selectedTheme,
			themeLock: s.themeLock,
			/* v8 ignore next -- globalTheme is initialized for unlocked editor states; fallback is migration hardening. */
			globalTheme: s.themeLock ? s.selectedTheme : (s.globalTheme ?? ''),
			tokens: s.tokenOverrides
		},
		// A completed Save advances the saved snapshot without undoing newer mode transitions or edits.
		...(current.library === s.library ? { library } : {}),
		...(s.mode.kind === 'definition' && current.mode === s.mode
			? { mode: { ...current.mode, baseline: s.monitor } }
			: {})
	};
}

// =============================================================================================
// The reducer. Mutating ops dispatch `{ type: 'op', run, commit }` where `run(state)` returns a
// patch; commit runs recordHistory + bumps saveSeq (the persistence chokepoint). Dedicated
// actions cover selection, undo/redo, def-edit, history reset, baseline, and load — grouped into
// the sub-reducers below by concern.
// =============================================================================================

export type Action =
	| {
			type: 'op';
			run: (s: EditorState) => Patch;
			commit: boolean;
			coalesceKey?: string; // fold same-key commits within COALESCE_MS into one undo step
			at?: number; // the commit's wall-clock time (ms) — supplied by the dispatcher, for coalescing
	  }
	| { type: 'undo' }
	| { type: 'redo' }
	| { type: 'select'; id: string }
	| { type: 'selectClick'; id: string } // a plain click: collapses any marquee selection
	| { type: 'setSelectedIds'; ids: string[]; primary: string | null }
	| { type: 'enterDefEdit'; defId: string }
	| { type: 'newWidget'; id: string; name: string } // item 4: create an empty def + floating instance, then enter def-edit
	| { type: 'cloneDef'; defId: string; id: string } // duplicate a widget def + enter def-edit on the copy
	| { type: 'newFromTemplate'; definition: WidgetDef | null } // a new widget def seeded from a template
	| { type: 'previewTemplate'; definition: WidgetDef | null } // read-only preview (NOT cloned into the library)
	| { type: 'endPreview' } // leave a template preview, discarding it
	| { type: 'clonePreview' } // promote the previewed template into the library + keep editing it
	| { type: 'endDefEdit' }
	| { type: 'resetHistory' }
	| { type: 'setBaseline'; snapshot?: EditorState }
	| { type: 'load'; patch: Patch } // bulk set after reloadLayout (then resetHistory + setBaseline)
	| { type: 'setTheme'; name: string } // mirror selectedTheme (applyTheme is a side-effect)
	| { type: 'replaceMonitor'; monitor: MonitorLayout } // raw set (switchMonitor placeholder)
	// After a Save wrote the queued cross-monitor moves: clear them from the state AND from every
	// history entry, so an undo can't re-queue an extra that already landed on the other monitor.
	| { type: 'extrasFlushed'; extras?: EditorState['pendingExtras'] }
	| { type: 'revertToBaseline' } // Cancel / discard-on-switch: restore the saved baseline
	| { type: 'patch'; patch: Patch }; // a plain non-committing patch (selectedIds, etc.)

function commitPatch(next: EditorState, coalesceKey?: string, at?: number): Patch {
	// next is the post-edit state; record undo then advance saveSeq so the persistence effect fires.
	const hist = recordHistory(next, coalesceKey, at);
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

// The sticky add target (the container the last palette add went into) survives selecting anything
// INSIDE it (the new widget, a sibling, a nested container) and drops as soon as the user selects
// something outside it — a floating widget, another branch of the tree, or nothing at all.
function clearAddTargetIfOutside(next: EditorState): EditorState {
	if (!next.addTarget) return next;
	const target = findNode(next.monitor.root, next.addTarget);
	const inside = !!(next.selectedId && target && findNode(target, next.selectedId));
	return inside ? next : { ...next, addTarget: null };
}

type SelectionAction = Extract<Action, { type: 'select' | 'selectClick' | 'setSelectedIds' }>;

function reduceSelection(state: EditorState, action: SelectionAction): EditorState {
	switch (action.type) {
		case 'select':
			// A bare select (Outline/Inspector/menu) sets selectedId only → collapse the marquee.
			return clearAddTargetIfOutside(syncPrimary({ ...state, selectedId: action.id }, false));
		case 'selectClick':
			// A plain canvas click: set both + mark synced so syncPrimary is a no-op.
			return clearAddTargetIfOutside({
				...state,
				selectedId: action.id,
				selectedIds: [action.id],
				lastPrimary: action.id
			});
		case 'setSelectedIds':
			// Authoritative multi-select (marquee): set the set + primary, mark synced.
			return clearAddTargetIfOutside({
				...state,
				selectedIds: action.ids,
				selectedId: action.primary,
				lastPrimary: action.primary
			});
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
			// Revert every snapshot field; lastSnap=prev so the commit records nothing; then commit
			// (save). lastCommit resets so the next same-key edit can't fold into the undone burst.
			let next: EditorState = {
				...applySnap(state, prev),
				undoStack,
				redoStack,
				lastSnap: prev,
				lastCommit: null
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
				...applySnap(state, next0),
				undoStack,
				redoStack,
				lastSnap: next0,
				lastCommit: null
			};
			next = { ...next, ...commitPatch(next) };
			return next;
		}
		case 'resetHistory':
			return { ...state, ...resetHistoryPatch(state) };
		case 'setBaseline':
			return { ...state, ...setBaselinePatch(action.snapshot ?? state, state) };
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

// Add a freshly-built def to the library, then enter the def editor scoped to it. Shared by
// newWidget / cloneDef / newFromTemplate. Does NOT drop an instance onto the live monitor —
// designing a widget shouldn't place it on the layout; the whole library is persisted regardless
// (usePersistence writes every def), and the user instantiates it via the Inspector library
// palette. Assumes the caller already refused re-entry while another def is open (would orphan
// the retained desktop).
function enterNewDef(state: EditorState, def: WidgetDef): EditorState {
	const library: Library = {
		version: state.library?.version ?? 1,
		defs: [...(state.library?.defs ?? []), def]
	};
	const scopedMonitor = scopedMonitorFromDef(def);
	const next: EditorState = {
		...state,
		library,
		mode: { kind: 'definition', defId: def.id, desktop: state.monitor, baseline: scopedMonitor },
		monitor: scopedMonitor,
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
			// Refuse to start a new def while already editing one (would orphan the retained desktop). The UI
			// folds the open def (endDefEdit) before starting a new one.
			if (state.mode.kind !== 'layout') return state;
			const defId = action.id;
			const def: WidgetDef = {
				id: defId,
				name: action.name,
				size: { w: 200, h: 120 },
				child: container(`${defId}__root`, 'col', [], { align: 'stretch' })
			};
			return enterNewDef(state, def);
		}
		case 'cloneDef': {
			if (state.mode.kind !== 'layout') return state;
			const src = state.library?.defs.find((d) => d.id === action.defId);
			if (!src) return state;
			const defId = action.id;
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
			if (state.mode.kind !== 'layout') return state;
			const def = action.definition;
			return def ? enterNewDef(state, def) : state;
		}
		case 'previewTemplate': {
			// Read-only preview: scope to the template like a def edit, but DON'T add it to the library
			// (it lives in the preview mode). The Clone button promotes it; Close discards it.
			if (state.mode.kind !== 'layout') return state; // the UI folds any open def/preview first
			const def = action.definition;
			if (!def) return state;
			const next: EditorState = {
				...state,
				mode: { kind: 'preview', definition: def, desktop: state.monitor },
				monitor: scopedMonitorFromDef(def),
				selectedId: null
			};
			return syncPrimary({ ...next, ...resetHistoryPatch(next) }, false);
		}
		case 'endPreview': {
			if (state.mode.kind !== 'preview') return state;
			const next: EditorState = {
				...state,
				monitor: state.mode.desktop,
				mode: { kind: 'layout' },
				selectedId: null
			};
			return syncPrimary({ ...next, ...resetHistoryPatch(next) }, false);
		}
		case 'clonePreview': {
			// Promote the previewed template into the library and keep editing it (now unlocked).
			if (state.mode.kind !== 'preview') return state;
			const def = state.mode.definition;
			const library: Library = {
				version: state.library?.version ?? 1,
				defs: [...(state.library?.defs ?? []), def]
			};
			let next: EditorState = {
				...state,
				library,
				mode: {
					kind: 'definition',
					defId: def.id,
					desktop: state.mode.desktop,
					baseline: state.monitor
				} // a real def-edit baseline from here on
			};
			next = { ...next, ...commitPatch(next) }; // record + persist the new library def
			return next;
		}
		case 'enterDefEdit': {
			// Never re-enter while already designing — a nested enter would overwrite the retained desktop with
			// the scoped tree and lose the real monitor layout (the UI folds the open def first).
			if (state.mode.kind !== 'layout') return state;
			const def = state.library?.defs.find((d) => d.id === action.defId);
			if (!def) return state;
			// scopedMonitorFromDef self-heals oversized pad/gap for this widget's canvas — so opening a
			// def whose root was over-padded (e.g. copied from a full-monitor root) shows usable panes.
			const scopedMonitor = scopedMonitorFromDef(def);
			const next: EditorState = {
				...state,
				mode: {
					kind: 'definition',
					defId: action.defId,
					desktop: state.monitor,
					baseline: scopedMonitor
				},
				monitor: scopedMonitor,
				selectedId: null
			};
			return syncPrimary({ ...next, ...resetHistoryPatch(next) }, false);
		}
		case 'endDefEdit': {
			if (state.mode.kind === 'layout') return state;
			const library = editedLibrary(state);
			let next: EditorState = {
				...state,
				library,
				monitor: state.mode.desktop,
				mode: { kind: 'layout' },
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
	{ type: 'load' | 'setTheme' | 'replaceMonitor' | 'revertToBaseline' | 'extrasFlushed' }
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
				mode: { kind: 'layout' },
				library: b.library,
				selectedTheme: b.theme,
				themeLock: b.themeLock,
				globalTheme: b.globalTheme,
				tokenOverrides: b.tokens,
				pendingExtras: []
			};
		}
		case 'extrasFlushed': {
			// The extras are on disk now (other monitors' records). Strip them from the live state and
			// from every snapshot: an undo that restored a stale queue would re-append the same leaf
			// to the other monitor on the next Save (a duplicate).
			const flushed = new Set(action.extras ?? state.pendingExtras);
			const remaining = (extras: EditorState['pendingExtras']) =>
				extras.filter((extra) => !flushed.has(extra));
			const strip = (t: Snap): Snap =>
				t.pendingExtras.some((extra) => flushed.has(extra))
					? { ...t, pendingExtras: remaining(t.pendingExtras) }
					: t;
			return {
				...state,
				pendingExtras: remaining(state.pendingExtras),
				undoStack: state.undoStack.map(strip),
				redoStack: state.redoStack.map(strip),
				lastSnap: state.lastSnap ? strip(state.lastSnap) : null
			};
		}
	}
}

// A sticky add target whose container is gone (removed, undone, the monitor switched / reloaded, a
// def edit swapped the tree) is dropped — a later add must not resolve against a stale id.
function normalizeAddTarget(next: EditorState): EditorState {
	if (!next.addTarget || findNode(next.monitor.root, next.addTarget)) return next;
	return { ...next, addTarget: null };
}

export function editorReducer(state: EditorState, action: Action): EditorState {
	return normalizeAddTarget(reduce(state, action));
}

function reduce(state: EditorState, action: Action): EditorState {
	switch (action.type) {
		case 'op': {
			const patch = action.run(state);
			const setSelectedIds = 'selectedIds' in patch;
			let next = { ...state, ...patch };
			next = syncPrimary(next, setSelectedIds); // collapse the marquee unless the op set the set
			if (action.commit) next = { ...next, ...commitPatch(next, action.coalesceKey, action.at) };
			return next;
		}
		case 'patch': {
			const setSelectedIds = 'selectedIds' in action.patch;
			const next = syncPrimary({ ...state, ...action.patch }, setSelectedIds);
			// A selection change by patch (clear on monitor switch / cancel / reload) is a selection
			// change like any other for the sticky add target.
			return 'selectedId' in action.patch ? clearAddTargetIfOutside(next) : next;
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
		case 'extrasFlushed':
			return reduceLoad(state, action);
		default:
			return state;
	}
}

export const initialEditorState = (studio: boolean, seedMonitor: MonitorLayout): EditorState => ({
	monitor: seedMonitor,
	library: undefined,
	selectedId: null,
	selectedIds: [],
	lastPrimary: null,
	selectedTheme: '',
	themeLock: true, // default: one theme across all monitors (Settings unlocks per-monitor themes)
	globalTheme: '',
	tokenOverrides: {},
	mode: { kind: 'layout' },
	undoStack: [],
	redoStack: [],
	lastSnap: null,
	historyReady: false,
	lastCommit: null,
	savedBaseline: null,
	pendingExtras: [],
	saveSeq: 0,
	studio
});
