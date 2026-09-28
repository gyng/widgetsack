import { editingDefinitionId, definitionBaseline } from '../../core/editorMode';
// Owns the editable layout session: load, backup, preview, save, revert, switch and close.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../bridge/contract';
import { disposalScope } from '../../core/disposalScope';
import { emptyRoot, type Library } from '../../core/layoutTree';
import { parseLayoutAny } from '../../core/migration';
import {
	logClient,
	onStudioCloseRequested,
	mainWindowExists,
	reconcileOverlays,
	recreateMain
} from '../../overlay';
import { writeStudioMonitor } from './studioMonitorPref';
import { decideExternalChange } from './externalChange';
import { usePersistence } from './usePersistence';
import type { EditorState } from './types';
import type { EditorModel } from './useEditorModel';

type LayoutSessionOptions = {
	state: EditorState;
	myMonitor: string;
	setMyMonitor: (key: string) => void;
	dispatch: EditorModel['dispatch'];
	stateThemeRef: RefObject<string>;
	adoptTheme: (name: string) => Promise<void>;
	applyTheme: () => Promise<void>;
	onMonitorSwitch: () => void;
};

export function useLayoutSession({
	state,
	myMonitor,
	setMyMonitor,
	dispatch,
	stateThemeRef,
	adoptTheme,
	applyTheme,
	onMonitorSwitch
}: LayoutSessionOptions) {
	const {
		studio,
		monitor,
		library,
		selectedTheme,
		themeLock,
		tokenOverrides,
		savedBaseline,
		pendingExtras,
		saveSeq
	} = state;
	const editingDefId = editingDefinitionId(state.mode);
	const defEditBaseline = definitionBaseline(state.mode);
	const stateRef = useRef(state);
	const monitorRef = useRef(monitor);
	const switchUiRef = useRef(onMonitorSwitch);
	// dirty (item 2): immutable edits reassign these to new objects, so reference inequality = unsaved.
	const dirty =
		studio &&
		savedBaseline != null &&
		((!editingDefId && monitor !== savedBaseline.monitor) ||
			// While editing a def, `monitor` is the scoped tree; it's dirty once it diverges from the
			// def-edit baseline (so Save / Ctrl+S work mid-def-edit, as in Svelte).
			(editingDefId != null && defEditBaseline != null && monitor !== defEditBaseline) ||
			library !== savedBaseline.library ||
			selectedTheme !== savedBaseline.theme ||
			themeLock !== savedBaseline.themeLock ||
			tokenOverrides !== savedBaseline.tokens ||
			pendingExtras.length > 0);

	// Transient "✓ saved" confirmation in the powerbar after an explicit Save reaches disk — positive
	// feedback proportional to the studio's most consequential action (pushing the layout to overlays).
	const [savedFlash, setSavedFlash] = useState(false);
	const savedFlashTimer = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
		},
		[]
	);

	// A failed live (preview) write surfaces on the OVERLAY's edit mode through the same alert the
	// studio's Save uses — once per failure streak (the next success re-arms it), so a drag that
	// commits many times doesn't stack alerts. The studio has its Save button for this.
	const writeFailAlerted = useRef(false);
	// Set once backupLayoutFile (below) has copied an unparseable widgets.json aside: from then on
	// persistence may write a fresh file over it, so a rebuilt layout can actually be saved.
	const layoutBackedUpRef = useRef(false);
	const persistence = usePersistence(state, myMonitor, {
		layoutBackedUp: () => layoutBackedUpRef.current,
		onPreviewWriteResult: (ok) => {
			if (ok) {
				writeFailAlerted.current = false;
				return;
			}
			if (studio || writeFailAlerted.current) return;
			writeFailAlerted.current = true;
			window.alert(
				'Could not save the layout to disk — your changes are NOT saved. ' +
					'Check that widgets.json is writable, then try again.'
			);
		}
	});
	const {
		persistToDisk,
		writeBaseline,
		schedulePreviewWrite,
		clearPreviewWrite,
		flushPreviewWrite,
		previewPending
	} = persistence;

	// --- the save chokepoint bridge (saveLayout): the reducer bumps saveSeq on each commit; here we
	// schedule the debounced preview write — the SAME path for the studio and an overlay's edit mode
	// (an overlay used to persist synchronously per commit, which thrashed the disk on a drag and
	// could interleave two read-merge-write passes). Cross-monitor extras are queued in the reducer's
	// pendingExtras (set by moveNodeToMonitor before the commit), so the preview write omits them. ---
	const firstSave = useRef(true);
	useEffect(() => {
		if (firstSave.current) {
			firstSave.current = false;
			return; // saveSeq starts at 0; don't write on mount
		}
		schedulePreviewWrite();
	}, [saveSeq, schedulePreviewWrite]);

	// --- reloadLayout ---
	// An unparseable widgets.json is backed up ONCE per window (the backend copies it aside as
	// widgets.json.bad-<ts>) and the outcome is shown in a banner — the studio used to log this to the
	// client log only, so the user saw a blank stage with no idea their layout had been set aside.
	// `failed`: the copy itself errored — the corrupt file is still the only copy, so persistence
	// keeps refusing to write over it (see layoutBackedUpRef) and the banner says edits won't save.
	const [layoutBackup, setLayoutBackup] = useState<{
		path: string | null;
		failed: boolean;
	} | null>(null);
	const layoutBackupDone = useRef(false);
	const backupLayoutFile = useCallback(() => {
		if (layoutBackupDone.current) return;
		layoutBackupDone.current = true;
		invoke<string | null>(COMMANDS.backupLayout)
			.then((path) => {
				// `null` = there was no file to copy (nothing recoverable to lose) — writes may proceed too.
				if (path) logClient('warn', 'layout', `unparseable widgets.json backed up to ${path}`);
				layoutBackedUpRef.current = true;
				setLayoutBackup({ path, failed: false });
			})
			.catch((err) => {
				logClient('error', 'layout', `layout backup failed: ${String(err)}`);
				setLayoutBackup({ path: null, failed: true });
			});
	}, []);
	const loadRevision = useRef(0);
	useEffect(
		() => () => {
			loadRevision.current++;
		},
		[]
	);
	const reloadLayout = useCallback(async () => {
		const revision = ++loadRevision.current;
		const myMon = myMonitorRef.current;
		const isCurrent = () => revision === loadRevision.current && myMon === myMonitorRef.current;
		// historyReady=false up front (before the awaits) so neither the load nor any interim commit
		// is recorded as an edit (mirrors Svelte's first line). resetHistory below re-baselines.
		dispatch({ type: 'patch', patch: { historyReady: false } });
		const patch: Partial<EditorState> = {};
		let nextTheme: string | null = null;
		// Assigned once load_layout resolves — the catch uses it to tell "read but unparseable"
		// (back the file up before this session's default layout can be saved over it) from
		// "couldn't read at all" (nothing to copy). Mirrors overlay.ts populatedMonitorKeys.
		let raw: string | null = null;
		try {
			raw = await invoke<string | null>(COMMANDS.loadLayout);
			if (!isCurrent()) return;
			const obj = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
			const saved = obj ? parseLayoutAny(obj) : null;
			const mon = saved?.monitors[myMon];
			// A file that READ fine but didn't parse — the whole document, or just this monitor's
			// record (parseLayoutV2 drops an unparseable entry and keeps the rest) — is a parse
			// failure, not a fresh install: back it up before anything can be saved over it, and
			// load an EMPTY root rather than the demo seed (which the next preview write would
			// have persisted in its place).
			const rawMonitors = obj?.monitors;
			const hadEntry =
				!!rawMonitors && typeof rawMonitors === 'object' && myMon in (rawMonitors as object);
			if (obj && (saved === null || (hadEntry && !mon))) {
				logClient(
					'error',
					'layout',
					`widgets.json is unparseable (${saved === null ? 'whole file' : `monitor "${myMon}"`}); backing it up and loading an empty layout`
				);
				backupLayoutFile();
				patch.monitor = { root: emptyRoot(), floating: [] };
			} else if (mon) patch.monitor = mon;
			const lib = obj?.library;
			if (lib && typeof lib === 'object' && Array.isArray((lib as { defs?: unknown }).defs)) {
				patch.library = lib as Library;
			}
			// Theme: LOCKED (default) → the layout's global `theme` on every monitor; UNLOCKED → this
			// monitor's own `theme`, falling back to the global. `themeLock` absent ⇒ locked (back-compat).
			// An explicit '' (default tokens) on the monitor is honored — it's a string, so the ?? keeps it.
			const lock = obj?.themeLock !== false;
			patch.themeLock = lock;
			patch.globalTheme = typeof obj?.theme === 'string' ? obj.theme : '';
			const t = lock ? obj?.theme : (mon?.theme ?? obj?.theme);
			if (typeof t === 'string' && t !== stateThemeRef.current) {
				patch.selectedTheme = t;
				nextTheme = t;
			}
			const tk = obj?.tokens;
			patch.tokenOverrides =
				tk && typeof tk === 'object' && !Array.isArray(tk) ? (tk as Record<string, string>) : {};
		} catch (err) {
			if (!isCurrent()) return;
			logClient('error', 'layout', `load_layout failed; using default layout: ${String(err)}`);
			// The file READ but is not JSON at all: same as the unparseable case above — back it up and
			// load an EMPTY layout (not the demo seed, which the next preview write would persist over it).
			if (raw !== null) {
				backupLayoutFile();
				patch.monitor = { root: emptyRoot(), floating: [] };
			}
		}
		// historyReady=false during the load + interim awaits; clear pendingExtras; reset history;
		// set baseline — all folded into one dispatch so the loaded layout is the committed baseline.
		dispatch({ type: 'load', patch: { ...patch, historyReady: false, pendingExtras: [] } });
		// Write the loaded monitor into the ref synchronously so syncPrimaryOverlays (called right after
		// reloadLayout during init, before React commits the dispatch) decides primary-window
		// visibility from the post-load monitor — deterministic, like Svelte's synchronous `monitor = mon`.
		if (patch.monitor) monitorRef.current = patch.monitor;
		// Apply the theme css for the new selectedTheme (side-effect), then re-baseline + reset history.
		if (nextTheme !== null) await adoptTheme(nextTheme);
		if (!isCurrent()) return;
		dispatch({ type: 'resetHistory' });
		dispatch({ type: 'setBaseline' });
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [dispatch, adoptTheme, backupLayoutFile]);
	// myMonitor latest, for reloadLayout/persist reading inside listeners. Mirrored in the commit
	// effect below (not during render).
	const myMonitorRef = useRef(myMonitor);

	const commitSave = useCallback(async (): Promise<boolean> => {
		if (!studio) return true;
		clearPreviewWrite();
		const snapshot = stateRef.current;
		const monitorKey = myMonitorRef.current;
		const revision = loadRevision.current;
		const ok = await persistToDisk(snapshot.pendingExtras);
		if (!ok) {
			// Hard failure (disk full / file locked / permissions): keep `dirty` true and the pending
			// cross-monitor moves queued (so a retry re-attempts them), and tell the user plainly. Flashing
			// "✓ saved" + clearing the dirty cue here — as we used to — would hide real data loss.
			window.alert(
				'Could not save the layout to disk — your changes are NOT saved. ' +
					'Check that widgets.json is writable, then try again.'
			);
			return false;
		}
		// The extras are on the other monitors' records now: clear them from the state AND from the
		// undo history, so an undo can't re-queue one (a second Save would duplicate it there).
		if (monitorKey !== myMonitorRef.current || revision !== loadRevision.current) return false;
		dispatch({ type: 'extrasFlushed', extras: snapshot.pendingExtras });
		dispatch({ type: 'setBaseline', snapshot });
		// Flash a transient confirmation in the powerbar (the write reached disk → the overlays reload).
		setSavedFlash(true);
		if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
		savedFlashTimer.current = window.setTimeout(() => setSavedFlash(false), 2200);
		return true;
	}, [studio, clearPreviewWrite, persistToDisk, dispatch]);
	// Mirrored in the effect below (read only from the studio-close listener).
	const pendingExtrasRef = useRef(pendingExtras);
	const commitSaveRef = useRef(commitSave);

	// Close only after all edits reach disk. Failure keeps the retryable draft alive.
	const prepareClose = useCallback(async (): Promise<boolean> => {
		const revision = loadRevision.current;
		const sequence = stateRef.current.saveSeq;
		const unchanged = () =>
			revision === loadRevision.current && sequence === stateRef.current.saveSeq;
		try {
			if (dirtyRef.current || pendingExtrasRef.current.length > 0) {
				if (!(await commitSaveRef.current())) return false;
			} else if (!(await flushPreviewWrite()) && !(await commitSaveRef.current())) {
				return false;
			}
		} catch (err) {
			console.warn('save on studio close failed', err);
			window.alert(
				'Could not save the layout to disk — the studio will stay open. Try saving again.'
			);
			return false;
		}
		if (!unchanged()) return false; // new edits must survive a close-time Save
		// While `main` is destroyed to reclaim its renderer (empty primary), nothing drives overlay
		// reconcile. The studio is the editing surface, so on close it applies the final layout: spawn
		// /close secondary overlays for the edited monitors, and bring `main` back if the primary was
		// re-populated. ONLY when `main` is absent: a live `main` already reconciles on the
		// `layout_changed` this save emits, and two reconciles in different webviews don't share a
		// single-flight — both would try to create the same window (the loser errors).
		try {
			if (!(await mainWindowExists())) {
				await reconcileOverlays();
				await recreateMain();
			}
		} catch (err) {
			console.warn('overlay reconcile on studio close failed', err);
		}
		return unchanged();
	}, [flushPreviewWrite]);
	useEffect(() => {
		if (!studio) return;
		const scope = disposalScope((err) => console.warn('studio close cleanup failed', err));
		onStudioCloseRequested(prepareClose).then(scope.add);
		return () => scope.dispose();
	}, [studio, prepareClose]);

	const savedBaselineRef = useRef(savedBaseline); // mirrored in the effect below
	// Restore the editor AND the on-disk layout to the saved baseline, reverting the live preview.
	// We write the baseline values DIRECTLY (writeBaseline) rather than via persistToDisk because
	// the reducer's revert set lags a render — the disk write must use the baseline immediately.
	const revertDraftToDisk = useCallback(async () => {
		if (!savedBaselineRef.current) return true;
		const b = savedBaselineRef.current;
		clearPreviewWrite();
		if (!(await writeBaseline(b, myMonitorRef.current))) {
			window.alert(
				'Could not restore the saved layout to disk — your edits are still available. Try again.'
			);
			return false;
		}
		dispatch({ type: 'revertToBaseline' });
		return true;
	}, [dispatch, clearPreviewWrite, writeBaseline]);

	const cancelEdits = useCallback(async () => {
		if (!studio || !dirtyRef.current || !savedBaselineRef.current) return;
		if (!window.confirm('Discard all unsaved changes since the last save?')) return;
		if (!(await revertDraftToDisk())) return;
		// Drop out of def editing only once the saved baseline has reached disk.
		dispatch({
			type: 'patch',
			patch: { mode: { kind: 'layout' }, selectedId: null, selectedIds: [] }
		});
		applyTheme();
		dispatch({ type: 'resetHistory' });
	}, [studio, dispatch, revertDraftToDisk, applyTheme]);
	const dirtyRef = useRef(dirty); // mirrored in the effect below
	// Overlay edit mode: edits diverge from the baseline anchored when edit mode was ENTERED (setEdit
	// re-baselines on the rising edge; the studio's `dirty` is studio-gated). "Revert" writes that
	// baseline straight back to disk, same path as the studio's Cancel.
	const overlayDirty = !studio && savedBaseline != null && monitor !== savedBaseline.monitor;
	const revertOverlayEdits = useCallback(async () => {
		if (!savedBaselineRef.current) return;
		if (
			!window.confirm(
				'Restore the layout as it was when you entered edit mode? Edits made since then are discarded.'
			)
		)
			return;
		if (!(await revertDraftToDisk())) return;
		dispatch({ type: 'patch', patch: { selectedId: null, selectedIds: [] } });
		dispatch({ type: 'resetHistory' });
	}, [dispatch, revertDraftToDisk]);

	// --- studio: switch monitor ---
	const switchMonitor = useCallback(
		async (key: string) => {
			if (key === myMonitorRef.current) return;
			// No preview timer may outlive this point: one that fired after the switch used to write
			// the placeholder EMPTY tree (below) under the NEW key. A pending write for the old
			// monitor is landed now (flushed, not dropped — an undo back to baseline still debouncing
			// would otherwise leave the old monitor's file one edit behind); the dirty path then
			// reverts it to the baseline on confirm, exactly as before.
			if (!(await flushPreviewWrite())) {
				window.alert(
					'Could not save the current monitor — try saving again before switching monitors.'
				);
				return;
			}
			if (dirtyRef.current) {
				if (!window.confirm('Discard unsaved changes to this monitor and switch?')) return;
				if (!(await revertDraftToDisk())) return;
			}
			setMyMonitor(key);
			// Eager latest-ref sync (mirrors the ref-sync effect below); read by later async steps in this
			// handler. (react-hooks/immutability flagged this under eslint-plugin-react-hooks v7; oxlint's
			// react plugin has no equivalent rule, so this is now just a plain mutation, no directive needed.)
			myMonitorRef.current = key;
			if (studio) writeStudioMonitor(key); // sticky across reloads
			dispatch({ type: 'patch', patch: { selectedId: null, selectedIds: [] } });
			switchUiRef.current();
			dispatch({ type: 'replaceMonitor', monitor: { root: emptyRoot(), floating: [] } });
			await reloadLayout();
		},
		[studio, dispatch, revertDraftToDisk, reloadLayout, flushPreviewWrite, setMyMonitor]
	);
	// --- widgets.json changed under the studio by ANOTHER writer (an overlay's edit mode, a hand
	// edit, a sync tool). Reload silently when nothing here would be lost; otherwise raise the
	// "Layout changed on disk" banner — the studio used to ignore every change (it is always
	// editing) and then clobber the external edit on its next preview write. ---
	const [externalChange, setExternalChange] = useState(false);
	const onForeignLayoutChange = useCallback(() => {
		const verdict = decideExternalChange({
			dirty: dirtyRef.current,
			previewPending: previewPending(),
			designing: stateRef.current.mode.kind !== 'layout'
		});
		if (verdict === 'reload') void reloadLayout();
		else setExternalChange(true);
	}, [previewPending, reloadLayout]);
	const reloadExternal = useCallback(() => {
		setExternalChange(false);
		clearPreviewWrite(); // don't let a debouncing edit overwrite what we're about to load
		// Leave any open def edit / template preview first: the reload replaces `monitor` wholesale.
		dispatch({
			type: 'patch',
			patch: {
				mode: { kind: 'layout' },
				selectedId: null,
				selectedIds: []
			}
		});
		void reloadLayout();
	}, [clearPreviewWrite, dispatch, reloadLayout]);
	// Keep mine: the next preview write / Save reasserts this editor's state over the external edit.
	const keepMine = useCallback(() => {
		setExternalChange(false);
		schedulePreviewWrite();
	}, [schedulePreviewWrite]);
	const onForeignLayoutChangeRef = useRef(onForeignLayoutChange); // mirrored in the effect below

	useEffect(() => {
		stateRef.current = state;
		myMonitorRef.current = myMonitor;
		monitorRef.current = monitor;
		pendingExtrasRef.current = pendingExtras;
		commitSaveRef.current = commitSave;
		savedBaselineRef.current = savedBaseline;
		dirtyRef.current = dirty;
		onForeignLayoutChangeRef.current = onForeignLayoutChange;
		switchUiRef.current = onMonitorSwitch;
	});
	return {
		dismissLayoutBackup: () => setLayoutBackup(null),
		dirty,
		overlayDirty,
		savedFlash,
		layoutBackup,
		externalChange,
		reloadLayout,
		commitSave,
		prepareClose,
		cancelEdits,
		revertOverlayEdits,
		switchMonitor,
		reloadExternal,
		keepMine,
		flushPreviewWrite,
		onForeignLayoutChangeRef,
		monitorRef,
		myMonitorRef
	};
}
