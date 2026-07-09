// usePersistence is the one disk-touching seam, but it's not *just* glue: persistToDisk /
// writeBaseline assemble the widgets.json object from the live editor state with real branch logic
// (theme lock placement, the mid-def-edit library fold, the cross-monitor `extras` merge, the
// conditional theme/themeLock/tokens fields) and re-read + merge the OTHER monitors off disk. We
// mock only the Tauri `invoke` adapter, then assert the exact JSON handed to save_layout and the
// success/failure boolean contract. The debounce timer is driven with fake timers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePersistence } from './usePersistence';
import { COMMANDS } from '../../bridge/contract';
import { container, leaf, type Library, type MonitorLayout } from '../../core/layoutTree';
import { createWidget } from '../../core/widget';
import type { Baseline, EditorState, Extra } from './types';

// One mocked Tauri command surface for the whole file. invoke(loadLayout) returns whatever
// `loadLayoutRaw` is set to (the on-disk file); invoke(saveLayout) records its args and resolves
// (or rejects when `saveRejects`) so we can read back the written JSON + the resolved boolean.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
	invoke: (...args: unknown[]) => invoke(...args)
}));

let loadLayoutRaw: string | null = null;
let saveRejects = false;
let savedContents: string | null = null;

beforeEach(() => {
	loadLayoutRaw = null;
	saveRejects = false;
	savedContents = null;
	invoke.mockReset();
	invoke.mockImplementation(async (cmd: string, args?: { contents?: string }) => {
		if (cmd === COMMANDS.loadLayout) return loadLayoutRaw;
		if (cmd === COMMANDS.saveLayout) {
			if (saveRejects) throw new Error('save_layout rejected');
			savedContents = args?.contents ?? null;
			return undefined;
		}
		throw new Error(`unexpected command ${cmd}`);
	});
});
afterEach(() => {
	vi.useRealTimers();
});

// The parsed object handed to save_layout (the last write).
function written(): Record<string, unknown> {
	expect(savedContents).not.toBeNull();
	return JSON.parse(savedContents!) as Record<string, unknown>;
}

// A monitor with one docked text widget.
function monitorWith(id = 'w1'): MonitorLayout {
	return {
		root: container('root', 'col', [leaf(createWidget('text', id))], { align: 'stretch' }),
		floating: []
	};
}

// A minimal EditorState — only the persistence-relevant slice is read by the hook.
function editorState(over: Partial<EditorState> = {}): EditorState {
	return {
		monitor: monitorWith(),
		library: undefined,
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
		historyReady: true,
		savedBaseline: null,
		pendingExtras: [],
		saveSeq: 0,
		studio: true,
		...over
	};
}

describe('persistToDisk — widgets.json assembly', () => {
	it('writes version 2 + this monitor under its key, and omits theme/library/tokens when bare', async () => {
		const { result } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		let ok = false;
		await act(async () => {
			ok = await result.current.persistToDisk([]);
		});
		expect(ok).toBe(true);
		const out = written();
		expect(out.version).toBe(2);
		// LOCKED + no selected theme + no tokens + no library → only version + monitors are written.
		expect(out).not.toHaveProperty('theme');
		expect(out).not.toHaveProperty('themeLock');
		expect(out).not.toHaveProperty('tokens');
		expect(out).not.toHaveProperty('library');
		const monitors = out.monitors as Record<string, MonitorLayout>;
		expect(Object.keys(monitors)).toEqual(['mon-A']);
		// A locked theme strips any per-monitor `theme` field off the record.
		expect(monitors['mon-A']).not.toHaveProperty('theme');
	});

	it('LOCKED: the selection becomes the GLOBAL theme and the monitor record carries none', async () => {
		const { result } = renderHook(() =>
			usePersistence(editorState({ themeLock: true, selectedTheme: 'builtin:nord' }), 'mon-A')
		);
		await act(async () => {
			await result.current.persistToDisk([]);
		});
		const out = written();
		expect(out.theme).toBe('builtin:nord');
		expect(out).not.toHaveProperty('themeLock'); // absent ⇒ locked (the default)
		const monitors = out.monitors as Record<string, MonitorLayout>;
		expect(monitors['mon-A']).not.toHaveProperty('theme');
	});

	it('UNLOCKED: the selection pins onto THIS monitor and themeLock:false is written', async () => {
		const { result } = renderHook(() =>
			usePersistence(editorState({ themeLock: false, selectedTheme: 'mytheme' }), 'mon-A')
		);
		await act(async () => {
			await result.current.persistToDisk([]);
		});
		const out = written();
		expect(out.themeLock).toBe(false);
		const monitors = out.monitors as Record<string, MonitorLayout>;
		expect((monitors['mon-A'] as MonitorLayout).theme).toBe('mytheme');
		// The selection is NOT promoted to the global theme when unlocked (none on disk → none global).
		expect(out).not.toHaveProperty('theme');
	});

	it('writes library + tokens when present', async () => {
		const library: Library = { version: 1, defs: [] };
		const { result } = renderHook(() =>
			usePersistence(editorState({ library, tokenOverrides: { '--accent': '#f00' } }), 'mon-A')
		);
		await act(async () => {
			await result.current.persistToDisk([]);
		});
		const out = written();
		expect(out.library).toEqual(library);
		expect(out.tokens).toEqual({ '--accent': '#f00' });
	});

	it('merges the OTHER monitors + library + global theme already on disk', async () => {
		// The file already holds monitor mon-B, a library, and a global theme; persistToDisk must
		// re-read and preserve them while replacing only mon-A.
		const fileLib: Library = { version: 1, defs: [] };
		loadLayoutRaw = JSON.stringify({
			version: 2,
			monitors: { 'mon-B': monitorWith('other') },
			library: fileLib,
			theme: 'builtin:dark'
		});
		// Unlocked here so the GLOBAL theme falls back to the file's existing global (inherit-default).
		const { result } = renderHook(() => usePersistence(editorState({ themeLock: false }), 'mon-A'));
		await act(async () => {
			await result.current.persistToDisk([]);
		});
		const out = written();
		const monitors = out.monitors as Record<string, MonitorLayout>;
		expect(Object.keys(monitors).sort()).toEqual(['mon-A', 'mon-B']);
		expect(out.library).toEqual(fileLib); // editor had no library → fell back to the file's
		expect(out.theme).toBe('builtin:dark'); // unlocked → keep the file's global as inherit-default
	});

	it('appends a cross-monitor `extra` leaf onto its target monitor without clobbering this one', async () => {
		const extras: Extra[] = [{ key: 'mon-B', leaf: leaf(createWidget('text', 'moved')) }];
		const { result } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		await act(async () => {
			await result.current.persistToDisk(extras);
		});
		const monitors = written().monitors as Record<string, MonitorLayout>;
		expect(monitors['mon-A']).toBeDefined();
		expect(monitors['mon-B'].floating?.map((l) => l.id)).toEqual(['moved']);
	});

	it('an extra whose key === this monitor is skipped (no double-append)', async () => {
		const extras: Extra[] = [{ key: 'mon-A', leaf: leaf(createWidget('text', 'dup')) }];
		const { result } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		await act(async () => {
			await result.current.persistToDisk(extras);
		});
		const monitors = written().monitors as Record<string, MonitorLayout>;
		// mon-A is the editor's own monitor (one widget), NOT the extra'd one.
		expect(monitors['mon-A'].root.children.map((c) => c.id)).toEqual(['w1']);
	});

	it('mid def-edit: folds the in-progress def child back into the library and persists the REAL monitor', async () => {
		const editingChild = container('def-root', 'row', [leaf(createWidget('text', 'inner'))]);
		const library: Library = {
			version: 1,
			defs: [{ id: 'd1', name: 'D1', size: { w: 200, h: 100 }, child: container('old', 'col', []) }]
		};
		const realMonitor = monitorWith('real-widget');
		const { result } = renderHook(() =>
			usePersistence(
				editorState({
					editingDefId: 'd1',
					library,
					monitor: { root: editingChild, floating: [] }, // the scoped editing tree
					savedMonitor: realMonitor // the real layout to persist
				}),
				'mon-A'
			)
		);
		await act(async () => {
			await result.current.persistToDisk([]);
		});
		const out = written();
		const outLib = out.library as Library;
		// The def's child was replaced with the scoped editing tree…
		expect(outLib.defs[0].child).toEqual(editingChild);
		// …and the REAL monitor (savedMonitor), not the scoped tree, is what got written.
		const monitors = out.monitors as Record<string, MonitorLayout>;
		expect(monitors['mon-A'].root.children.map((c) => c.id)).toEqual(['real-widget']);
	});

	it('folds only the matching def, leaving sibling defs untouched', async () => {
		const editingChild = container('def-root', 'row', []);
		const sibling = {
			id: 'd2',
			name: 'D2',
			size: { w: 10, h: 10 },
			child: container('s', 'col', [])
		};
		const library: Library = {
			version: 1,
			defs: [
				{ id: 'd1', name: 'D1', size: { w: 1, h: 1 }, child: container('old', 'col', []) },
				sibling
			]
		};
		const { result } = renderHook(() =>
			usePersistence(
				editorState({
					editingDefId: 'd1',
					library,
					monitor: { root: editingChild, floating: [] },
					savedMonitor: monitorWith('real')
				}),
				'mon-A'
			)
		);
		await act(async () => {
			await result.current.persistToDisk([]);
		});
		const outLib = written().library as Library;
		expect(outLib.defs[0].child).toEqual(editingChild); // d1 folded
		expect(outLib.defs[1]).toEqual(sibling); // d2 passed through unchanged
	});

	it('appends an extra alongside the on-disk monitor’s EXISTING floating leaves', async () => {
		// mon-B already has a floating leaf on disk → the extra is appended after it (no clobber).
		loadLayoutRaw = JSON.stringify({
			version: 2,
			monitors: {
				'mon-B': {
					root: container('root', 'col', []),
					floating: [leaf(createWidget('text', 'pre'))]
				}
			}
		});
		const extras: Extra[] = [{ key: 'mon-B', leaf: leaf(createWidget('text', 'added')) }];
		const { result } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		await act(async () => {
			await result.current.persistToDisk(extras);
		});
		const monitors = written().monitors as Record<string, MonitorLayout>;
		expect(monitors['mon-B'].floating?.map((l) => l.id)).toEqual(['pre', 'added']);
	});

	it('appends an extra onto an on-disk monitor that has no `floating` field', async () => {
		// The on-disk mon-B record omits `floating`, but parseLayoutAny's parseMonitor normalises it
		// to [] before the extras loop ever sees the record — the `t.floating ?? []` arm in the loop
		// itself stays defensive-only (no real input reaches it).
		loadLayoutRaw = JSON.stringify({
			version: 2,
			monitors: { 'mon-B': { root: container('root', 'col', []) } }
		});
		const extras: Extra[] = [{ key: 'mon-B', leaf: leaf(createWidget('text', 'late')) }];
		const { result } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		await act(async () => {
			await result.current.persistToDisk(extras);
		});
		const monitors = written().monitors as Record<string, MonitorLayout>;
		expect(monitors['mon-B'].floating?.map((l) => l.id)).toEqual(['late']);
	});

	it('returns false when save_layout rejects (the caller must not mark it saved)', async () => {
		saveRejects = true;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { result } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		let ok = true;
		await act(async () => {
			ok = await result.current.persistToDisk([]);
		});
		expect(ok).toBe(false);
		warn.mockRestore();
	});

	it('survives a load_layout that throws / returns garbage and still writes a fresh monitors map', async () => {
		// loadLayout rejects → the catch falls back to an empty monitors map (no other monitors).
		invoke.mockImplementation(async (cmd: string, args?: { contents?: string }) => {
			if (cmd === COMMANDS.loadLayout) throw new Error('disk read failed');
			if (cmd === COMMANDS.saveLayout) {
				savedContents = args?.contents ?? null;
				return undefined;
			}
		});
		const { result } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		await act(async () => {
			await result.current.persistToDisk([]);
		});
		const monitors = written().monitors as Record<string, MonitorLayout>;
		expect(Object.keys(monitors)).toEqual(['mon-A']);
	});
});

describe('writeBaseline — revert path', () => {
	function baseline(over: Partial<Baseline> = {}): Baseline {
		return {
			monitor: monitorWith('base'),
			library: undefined,
			theme: '',
			themeLock: true,
			tokens: {},
			...over
		};
	}

	it('writes the baseline values for THIS monitor while preserving the file’s other monitors', async () => {
		loadLayoutRaw = JSON.stringify({
			version: 2,
			monitors: { 'mon-B': monitorWith('keepme') }
		});
		const { result } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		let ok = false;
		await act(async () => {
			ok = await result.current.writeBaseline(baseline(), 'mon-A');
		});
		expect(ok).toBe(true);
		const monitors = written().monitors as Record<string, MonitorLayout>;
		expect(monitors['mon-A'].root.children.map((c) => c.id)).toEqual(['base']);
		expect(monitors['mon-B'].root.children.map((c) => c.id)).toEqual(['keepme']);
	});

	it('UNLOCKED baseline pins its theme on the monitor record + writes themeLock:false', async () => {
		const { result } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		await act(async () => {
			await result.current.writeBaseline(
				baseline({ themeLock: false, theme: 'btheme', tokens: { '--x': '1' } }),
				'mon-A'
			);
		});
		const out = written();
		expect(out.themeLock).toBe(false);
		expect(out.tokens).toEqual({ '--x': '1' });
		const monitors = out.monitors as Record<string, MonitorLayout>;
		expect((monitors['mon-A'] as MonitorLayout).theme).toBe('btheme');
	});

	it('LOCKED baseline promotes its theme to the global theme + strips it off the record', async () => {
		const { result } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		await act(async () => {
			await result.current.writeBaseline(
				baseline({ themeLock: true, theme: 'builtin:nord', library: { version: 1, defs: [] } }),
				'mon-A'
			);
		});
		const out = written();
		expect(out.theme).toBe('builtin:nord');
		expect(out).not.toHaveProperty('themeLock');
		const monitors = out.monitors as Record<string, MonitorLayout>;
		expect(monitors['mon-A']).not.toHaveProperty('theme');
		expect(out.library).toEqual({ version: 1, defs: [] });
	});

	it('LOCKED baseline with no theme inherits the file’s existing global theme', async () => {
		// The file already has a string global theme; a locked baseline whose own theme is '' must keep
		// the file's as the global (b.theme || fileTheme).
		loadLayoutRaw = JSON.stringify({
			version: 2,
			monitors: { 'mon-A': monitorWith() },
			theme: 'builtin:dracula'
		});
		const { result } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		await act(async () => {
			await result.current.writeBaseline(baseline({ themeLock: true, theme: '' }), 'mon-A');
		});
		expect(written().theme).toBe('builtin:dracula');
	});

	it('returns false when save_layout rejects', async () => {
		saveRejects = true;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { result } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		let ok = true;
		await act(async () => {
			ok = await result.current.writeBaseline(baseline(), 'mon-A');
		});
		expect(ok).toBe(false);
		warn.mockRestore();
	});

	it('falls back to an empty monitors map when the load read throws', async () => {
		invoke.mockImplementation(async (cmd: string, args?: { contents?: string }) => {
			if (cmd === COMMANDS.loadLayout) throw new Error('read failed');
			savedContents = args?.contents ?? null;
			return undefined;
		});
		const { result } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		await act(async () => {
			await result.current.writeBaseline(baseline(), 'mon-A');
		});
		const monitors = written().monitors as Record<string, MonitorLayout>;
		expect(Object.keys(monitors)).toEqual(['mon-A']);
	});
});

describe('debounced preview write', () => {
	it('schedulePreviewWrite fires a persistToDisk ~150ms later', async () => {
		vi.useFakeTimers();
		const { result } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		act(() => result.current.schedulePreviewWrite());
		expect(savedContents).toBeNull(); // nothing written yet
		await act(async () => {
			await vi.advanceTimersByTimeAsync(160);
		});
		expect(savedContents).not.toBeNull();
		const monitors = written().monitors as Record<string, MonitorLayout>;
		expect(Object.keys(monitors)).toEqual(['mon-A']);
	});

	it('clearPreviewWrite cancels a pending write', async () => {
		vi.useFakeTimers();
		const { result } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		act(() => result.current.schedulePreviewWrite());
		act(() => result.current.clearPreviewWrite());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(300);
		});
		expect(savedContents).toBeNull();
	});

	it('a second schedule debounces the first (only one write fires)', async () => {
		vi.useFakeTimers();
		const { result } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		act(() => result.current.schedulePreviewWrite());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100); // not yet
		});
		act(() => result.current.schedulePreviewWrite()); // resets the timer
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100); // 100ms after the RESET → still pending
		});
		const saveCalls = () => invoke.mock.calls.filter((c) => c[0] === COMMANDS.saveLayout).length;
		expect(saveCalls()).toBe(0);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100); // now past 150 from the reset
		});
		expect(saveCalls()).toBe(1);
	});

	it('clears the pending preview write on unmount', async () => {
		vi.useFakeTimers();
		const { result, unmount } = renderHook(() => usePersistence(editorState(), 'mon-A'));
		act(() => result.current.schedulePreviewWrite());
		unmount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(300);
		});
		expect(savedContents).toBeNull();
	});
});
