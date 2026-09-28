// Live-preview persistence (item 3): the only place that touches disk. persistToDisk re-reads
// widgets.json to merge OTHER monitors' layouts + library + theme + tokens, folds the in-progress
// def, and writes. A commit (saveSeq bump) — in the studio AND in an overlay's edit mode — debounces
// a preview write ~150ms via a ref timer so the desktop overlays preview unsaved changes without
// per-keystroke disk thrash; `dirty` still tracks divergence from the saved baseline. commitSave
// flushes; cancelEdits/revertDraftToDisk revert; a pending preview write is FLUSHED (not dropped)
// on unmount so the last edit before a close still lands. Token write is authoritative (empty ->
// omit tokens).
//
// Preview, Save, and revert share one ordered queue. Waiting previews for the same monitor
// coalesce, while Save and revert are barriers. Flush waits for active and queued work, even after
// the debounce timer has fired. Each preview retains its original monitor key.
import { useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../bridge/contract';
import type { Library } from '../../core/layoutTree';
import {
	planLayoutSave,
	planLayoutRevert,
	type PersistView,
	type LayoutFile,
	type LayoutWritePlan
} from '../../core/layoutPersistence';
import { parseLayoutAny } from '../../core/migration';
import { writeQueue } from '../../core/writeQueue';
import type { Baseline, EditorState, Extra } from './types';

export type Persistence = {
	// Flush the debounced preview write now (Save): writes incl. queued cross-monitor moves. Resolves
	// `true` on a successful disk write, `false` if save_layout rejected — the caller (commitSave) must
	// NOT clear the dirty flag / show "saved" on `false`, else an unwritten layout looks persisted.
	persistToDisk: (extras: Extra[]) => Promise<boolean>;
	// Write a specific saved baseline back to disk (revertDraftToDisk / discard-on-switch). Used
	// instead of persistToDisk because the reducer's revert set lags a render — we write the
	// baseline values directly so the overlays return to the last-saved state immediately.
	writeBaseline: (b: Baseline, myMonitor: string) => Promise<boolean>;
	schedulePreviewWrite: () => void;
	// Drop a pending preview write (the revert paths, which write the baseline directly instead).
	clearPreviewWrite: () => void;
	// Run a pending preview write NOW (monitor switch / studio close): resolves once it has landed
	// (`true`), or immediately with `true` when nothing was pending.
	flushPreviewWrite: () => Promise<boolean>;
	// A preview write is pending (debounce timer armed) or in flight — the studio uses it to decide
	// whether an external layout change can be reloaded silently.
	previewPending: () => boolean;
};

export type PersistenceOptions = {
	// Told the outcome of every DEBOUNCED preview write (not Save / revert, whose callers already get
	// the boolean). An overlay's edit mode has no Save button: this is how a failed live write reaches
	// the user there, instead of the edits silently never landing on disk.
	onPreviewWriteResult?: (ok: boolean) => void;
	// `true` once this window has SUCCESSFULLY copied an unparseable widgets.json aside (Canvas's
	// backupLayoutFile). Until then a write over a file that no longer parses is refused — the corrupt
	// original must never be silently overwritten before it is backed up. Once it is, the file is
	// treated as empty so the user can rebuild (and Save) instead of every write failing forever.
	layoutBackedUp?: () => boolean;
};

// Re-read widgets.json before a write. Resolves `null` (→ the write is refused) when the file can't
// be read, or when it reads but doesn't parse and has NOT been backed up yet. With a backup in place
// an unparseable file is read as empty: whatever was recoverable is already in widgets.json.bad-*.
async function readLayoutFile(backedUp: boolean): Promise<LayoutFile | null> {
	try {
		const raw = await invoke<string | null>(COMMANDS.loadLayout);
		let obj: Record<string, unknown> | null = null;
		let recoverCorrupt = false;
		try {
			obj = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
		} catch (err) {
			if (!backedUp) throw err;
			recoverCorrupt = true;
			console.warn('widgets.json is unparseable but backed up; writing a fresh file over it', err);
		}
		return {
			monitors: (obj ? parseLayoutAny(obj) : null)?.monitors ?? {},
			fileLib: obj?.library as Library | undefined,
			fileTheme: typeof obj?.theme === 'string' ? (obj.theme as string) : undefined,
			recoverCorrupt
		};
	} catch (err) {
		console.warn('load_layout failed; refusing to overwrite widgets.json', err);
		return null;
	}
}

async function writePlan({ document, ...fields }: LayoutWritePlan): Promise<boolean> {
	try {
		await invoke(COMMANDS.saveLayout, { contents: JSON.stringify(document, null, 2), ...fields });
		return true;
	} catch (err) {
		console.warn('save_layout failed', err);
		return false;
	}
}

export function usePersistence(
	state: EditorState,
	myMonitor: string,
	options: PersistenceOptions = {}
): Persistence {
	// Latest callback without re-creating the (stable) scheduler; read when the timer fires.
	const optionsRef = useRef(options);
	useEffect(() => {
		optionsRef.current = options;
	});
	// Mirror the live state into a ref each render so the debounced writer + Save read the latest.
	const view = useRef<PersistView>({
		myMonitor,
		monitor: state.monitor,
		library: state.library,
		selectedTheme: state.selectedTheme,
		themeLock: state.themeLock,
		globalTheme: state.globalTheme,
		tokenOverrides: state.tokenOverrides,
		mode: state.mode,
		savedBaseline: state.savedBaseline
	});
	// Refresh the mirror in a commit effect (not during render); the debounced writer + Save read
	// view.current later (via setTimeout / a button press), never synchronously in this render.
	useEffect(() => {
		view.current = {
			myMonitor,
			monitor: state.monitor,
			library: state.library,
			selectedTheme: state.selectedTheme,
			themeLock: state.themeLock,
			globalTheme: state.globalTheme,
			tokenOverrides: state.tokenOverrides,
			mode: state.mode,
			savedBaseline: state.savedBaseline
		};
	});

	// While editing a def we must fold the scoped editing tree back into the library before a
	// write — but the library set is reducer-owned. The Canvas runs `endDefEdit`/save through the
	// reducer; for a mid-def preview write we fold a LOCAL copy here (mirrors syncEditingDef) so the
	// on-disk library stays in sync without mutating reducer state.
	const queue = useRef<ReturnType<typeof writeQueue> | null>(null);
	if (!queue.current) queue.current = writeQueue();
	const persistNow = useCallback(
		async (extras: Extra[], key: string, v = view.current): Promise<boolean> => {
			if (view.current.myMonitor !== key) return false; // the studio switched monitors since → stale, skip
			const file = await readLayoutFile(optionsRef.current.layoutBackedUp?.() ?? false);
			if (!file) return false;
			return writePlan(planLayoutSave(file, v, extras));
		},
		[]
	);
	const persistToDisk = useCallback(
		(extras: Extra[]): Promise<boolean> => {
			const snapshot = view.current;
			const key = snapshot.myMonitor;
			// An explicit Save must run even if a newer preview is queued behind it: it may carry
			// cross-monitor moves which preview writes do not include.
			return queue.current!.enqueue(() => persistNow(extras, key, snapshot));
		},
		[persistNow]
	);

	// Write a specific baseline straight to disk (revert path): merge the file's other monitors +
	// library/theme/tokens with the baseline's values for THIS monitor. Mirrors persistToDisk but
	// sources the editor values from `b` (and the baseline is never mid-def, so no def fold).
	const writeBaselineNow = useCallback(
		async (b: Baseline, myMonitor: string, v: PersistView): Promise<boolean> => {
			const file = await readLayoutFile(optionsRef.current.layoutBackedUp?.() ?? false);
			if (!file) return false;
			return writePlan(planLayoutRevert(file, b, myMonitor, v));
		},
		[]
	);

	const preview = useRef<{ timer: ReturnType<typeof setTimeout>; key: string } | null>(null);
	const clearPreviewWrite = useCallback(() => {
		clearTimeout(preview.current?.timer);
		preview.current = null;
	}, []);
	const writeBaseline = useCallback(
		(b: Baseline, key: string): Promise<boolean> => {
			clearPreviewWrite();
			// Capture before React applies the revert, including the globals that need restoring.
			const v = view.current;
			return queue.current!.enqueue(() => writeBaselineNow(b, key, v));
		},
		[clearPreviewWrite, writeBaselineNow]
	);
	const schedulePreviewWrite = useCallback(() => {
		clearPreviewWrite();
		// Capture the monitor the edit belongs to NOW: if the timer fires after a monitor switch,
		// persistNow sees the key mismatch and skips instead of writing under the new key.
		const key = view.current.myMonitor;
		const timer = setTimeout(() => {
			preview.current = null;
			void queue
				.current!.enqueue(() => persistNow([], key), key)
				.then((ok) => optionsRef.current.onPreviewWriteResult?.(ok));
		}, 150);
		preview.current = { timer, key };
	}, [clearPreviewWrite, persistNow]);
	const flushPreviewWrite = useCallback(async (): Promise<boolean> => {
		if (preview.current) {
			const { key } = preview.current;
			clearPreviewWrite();
			await queue.current!.enqueue(() => persistNow([], key), key);
		}
		return queue.current!.flush();
	}, [clearPreviewWrite, persistNow]);
	const previewPending = useCallback(
		() => preview.current !== null || queue.current!.pending(),
		[]
	);

	// Flush (not drop) a pending preview write on unmount: the studio closing right after an edit
	// must still land that edit — dropping it left the overlays one edit behind the editor.
	useEffect(() => () => void flushPreviewWrite(), [flushPreviewWrite]);

	return {
		persistToDisk,
		writeBaseline,
		schedulePreviewWrite,
		clearPreviewWrite,
		flushPreviewWrite,
		previewPending
	};
}
