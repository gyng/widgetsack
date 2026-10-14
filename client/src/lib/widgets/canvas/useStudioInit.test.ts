import { listen } from '@tauri-apps/api/event';
// The init must make every window role reveal itself from its OWN webview: a secondary overlay
// (?monitor=<key>) self-fits + shows via fillOwnMonitor — the spawn-side `tauri://created` setup
// dies with its creator when an empty-primary `main` self-destructs (renderer reclaim), which left
// secondaries permanently invisible. The primary keeps its fill/reconcile path.
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TelemetryHub } from '../../core/telemetry';
import type { StudioInitDeps } from './useStudioInit';
import { useStudioInit } from './useStudioInit';
import { logClient, overlayDrift, reconcileOverlays } from '../../overlay';

const fillOwnMonitor = vi.fn((key: string): Promise<void> => Promise.resolve(void key));
const fillPrimaryMonitor = vi.fn(() => Promise.resolve());
const setMainWindowVisible = vi.fn((visible: boolean) => Promise.resolve(void visible));
let monitorParamValue: string | null = null;
/** The topology-change callback the hook handed to watchDisplayChanges (the refit trigger). */
let onDisplayChange: (() => void) | null = null;
/** The drift probe handed alongside it (overlays only). */
let driftProbe: (() => Promise<string | null>) | null = null;
let onStableDisplayTick: (() => Promise<void>) | null = null;
let mainAlive = false;
/** The scale-change callback the hook registered via onOwnScaleChanged (overlays only). */
let onScaleChange: (() => void) | null = null;

vi.mock('../../overlay', () => ({
	fillOwnMonitor: (key: string) => fillOwnMonitor(key),
	fillPrimaryMonitor: () => fillPrimaryMonitor(),
	setMainWindowVisible: (v: boolean) => setMainWindowVisible(v),
	monitorParam: () => monitorParamValue,
	listThemes: vi.fn(async () => []),
	logClient: vi.fn(),
	mainWindowExists: vi.fn(async () => mainAlive),
	onOwnScaleChanged: vi.fn(async (cb: () => void) => {
		onScaleChange = cb;
		return () => undefined;
	}),
	overlayDrift: vi.fn(async () => null),
	reconcileOverlays: vi.fn(async () => undefined),
	studioMonitorOptions: vi.fn(async () => []),
	watchDisplayChanges: vi.fn(
		(cb: () => void, probe?: () => Promise<string | null>, stableTick?: () => Promise<void>) => {
			onDisplayChange = cb;
			driftProbe = probe ?? null;
			onStableDisplayTick = stableTick ?? null;
			return () => undefined;
		}
	)
}));
vi.mock('../../core/plugin', () => ({
	startAllSources: vi.fn(async () => () => undefined)
}));
/** Every Tauri event handler the hook registered, by event name (fire them to simulate an emit). */
const listeners = new Map<string, (e: { payload: unknown }) => void>();
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
		listeners.set(name, cb);
		return () => undefined;
	})
}));

/** The backend's shared overlay edit state, as `get_overlay_edit` reports it at join. */
let backendEdit = false;
vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async (cmd: string) => (cmd === 'get_overlay_edit' ? backendEdit : undefined))
}));

function makeDeps(overrides: Partial<StudioInitDeps> = {}): StudioInitDeps {
	return {
		studio: false,
		windowLabel: 'main',
		hub: {} as unknown as TelemetryHub,
		updateWorkArea: vi.fn(() => Promise.resolve()),
		reloadLayout: vi.fn(() => Promise.resolve()),
		reloadControls: vi.fn(() => Promise.resolve()),
		editMode: () => false,
		syncRects: vi.fn(),
		syncPrimaryOverlays: vi.fn(() => Promise.resolve()),
		applyTheme: vi.fn(() => Promise.resolve()),
		setThemeList: vi.fn(),
		setEdit: vi.fn(),
		setEditModeImmediate: vi.fn(),
		setMonitorOptions: vi.fn(),
		flushPreviewWrite: vi.fn(() => Promise.resolve()),
		onForeignLayoutChange: vi.fn(),
		reapplyPresentation: vi.fn(() => Promise.resolve()),
		...overrides
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	listeners.clear();
	monitorParamValue = null;
	onDisplayChange = null;
	driftProbe = null;
	onStableDisplayTick = null;
	mainAlive = false;
	onScaleChange = null;
	backendEdit = false;
});

describe('useStudioInit overlay edit mode', () => {
	it('a window created while the others edit joins in edit mode', async () => {
		backendEdit = true;
		const deps = makeDeps();
		renderHook(() => useStudioInit(deps));
		await waitFor(() => expect(deps.setEdit).toHaveBeenCalledWith(true));
	});

	it('broadcasts set the shared state instead of flipping the local one', async () => {
		let editing = true;
		const deps = makeDeps({
			editMode: () => editing,
			setEdit: vi.fn((v: boolean) => void (editing = v))
		});
		backendEdit = true;
		renderHook(() => useStudioInit(deps));
		await waitFor(() => expect(listeners.has('toggle_edit')).toBe(true));
		await waitFor(() => expect(deps.syncRects).toHaveBeenCalled());
		listeners.get('toggle_edit')!({ payload: true }); // already editing → stays editing
		expect(deps.setEdit).not.toHaveBeenCalled();
		listeners.get('toggle_edit')!({ payload: false });
		listeners.get('toggle_edit')!({ payload: false });
		expect(deps.setEdit).toHaveBeenCalledTimes(1);
		expect(editing).toBe(false);
	});
});

describe('useStudioInit interactive-rect resync', () => {
	it('re-sends the rects when the backend sets THIS window passive again', async () => {
		const deps = makeDeps({ windowLabel: 'overlay-2' });
		renderHook(() => useStudioInit(deps));
		await waitFor(() => expect(listeners.has('resync_interactive_rects')).toBe(true));
		await waitFor(() => expect(deps.syncRects).toHaveBeenCalled()); // init finished
		vi.mocked(deps.syncRects).mockClear();

		listeners.get('resync_interactive_rects')!({ payload: 'main' }); // another window
		expect(deps.syncRects).not.toHaveBeenCalled();
		listeners.get('resync_interactive_rects')!({ payload: 'overlay-2' });
		expect(deps.syncRects).toHaveBeenCalledTimes(1);
	});

	it('the studio does not listen (it never sends rects)', async () => {
		const deps = makeDeps({ studio: true });
		renderHook(() => useStudioInit(deps));
		await waitFor(() => expect(deps.setMonitorOptions).toHaveBeenCalled());
		expect(listeners.has('resync_interactive_rects')).toBe(false);
	});
});

describe('useStudioInit display-change refit', () => {
	it('a topology change re-fits a secondary AND refreshes its work area', async () => {
		monitorParamValue = 'DISPLAY3';
		const deps = makeDeps();
		renderHook(() => useStudioInit(deps));
		await waitFor(() => expect(fillOwnMonitor).toHaveBeenCalledWith('DISPLAY3'));
		await waitFor(() => expect(deps.syncRects).toHaveBeenCalled()); // init finished
		fillOwnMonitor.mockClear();
		vi.mocked(deps.updateWorkArea).mockClear();
		vi.mocked(deps.reapplyPresentation).mockClear();

		onDisplayChange!();
		await waitFor(() => expect(fillOwnMonitor).toHaveBeenCalledWith('DISPLAY3'));
		await waitFor(() =>
			expect(logClient).toHaveBeenCalledWith('info', 'overlay', 'refit start', {
				role: 'DISPLAY3'
			})
		);
		// The taskbar inset is re-read after the move: a window that moves without resizing fires
		// no `resize`, which was the only other trigger, leaving the flow root rebased on stale data.
		await waitFor(() => expect(deps.updateWorkArea).toHaveBeenCalledTimes(1));
		// And the presentation (click-through / z-order for the CURRENT edit state) is re-applied:
		// the fit is geometry only, and forcing click-through there broke edit mode on a refit.
		await waitFor(() => expect(deps.reapplyPresentation).toHaveBeenCalledTimes(1));
	});

	it('a refit that only moves the main overlay re-syncs its interactive rects after the presentation', async () => {
		const deps = makeDeps();
		renderHook(() => useStudioInit(deps));
		await waitFor(() => expect(deps.syncRects).toHaveBeenCalled()); // init finished
		const order: string[] = [];
		vi.mocked(deps.reapplyPresentation).mockImplementation(async () => void order.push('present'));
		vi.mocked(deps.syncRects).mockImplementation(() => void order.push('rects'));

		onDisplayChange!();
		// The rects are screen coordinates: a moved window's old ones are stale.
		await waitFor(() => expect(order).toEqual(['present', 'rects']));
	});

	it('a DPI/scale change of this window goes through the same single-flight refit', async () => {
		monitorParamValue = 'DISPLAY3';
		const deps = makeDeps();
		renderHook(() => useStudioInit(deps));
		await waitFor(() => expect(onScaleChange).not.toBeNull());
		await waitFor(() => expect(deps.syncRects).toHaveBeenCalled());
		fillOwnMonitor.mockClear();
		onScaleChange!();
		await waitFor(() => expect(fillOwnMonitor).toHaveBeenCalledWith('DISPLAY3'));
	});

	it('the studio registers no scale-change refit', async () => {
		renderHook(() => useStudioInit(makeDeps({ studio: true })));
		await waitFor(() => expect(onDisplayChange).not.toBeNull());
		expect(onScaleChange).toBeNull();
	});

	it('Studio reconciles missing overlays on a stable display tick only while main is gone', async () => {
		renderHook(() => useStudioInit(makeDeps({ studio: true })));
		await waitFor(() => expect(onStableDisplayTick).not.toBeNull());
		// main owns reconciliation; a second webview creating the same overlay races it.
		mainAlive = true;
		await onStableDisplayTick!();
		expect(reconcileOverlays).not.toHaveBeenCalled();
		mainAlive = false;
		await onStableDisplayTick!();
		expect(reconcileOverlays).toHaveBeenCalledTimes(1);
	});

	it('overlays hand the poller a drift probe for their own monitor; the studio does not', async () => {
		monitorParamValue = 'CRXED00-UID184576';
		renderHook(() => useStudioInit(makeDeps()));
		await waitFor(() => expect(driftProbe).not.toBeNull());
		await driftProbe!();
		expect(vi.mocked(overlayDrift)).toHaveBeenCalledWith('CRXED00-UID184576');

		// Studio: wait for ITS watchDisplayChanges registration (a fresh callback), then check that
		// it came with no probe — not the stale null from the reset.
		onDisplayChange = null;
		driftProbe = () => Promise.resolve('stale');
		monitorParamValue = null;
		renderHook(() => useStudioInit(makeDeps({ studio: true })));
		await waitFor(() => expect(onDisplayChange).not.toBeNull());
		expect(driftProbe).toBeNull();
	});

	it('a burst of topology changes collapses into one in-flight refit plus one trailing rerun', async () => {
		monitorParamValue = 'DISPLAY3';
		const deps = makeDeps();
		renderHook(() => useStudioInit(deps));
		await waitFor(() => expect(fillOwnMonitor).toHaveBeenCalledWith('DISPLAY3'));
		fillOwnMonitor.mockClear();
		// Hold the first refit open so the burst lands while it is in flight (an HDMI switch fires
		// the poller, the scale-change listener and the refit event within the same second).
		let release!: () => void;
		fillOwnMonitor.mockImplementationOnce(
			() => new Promise<void>((resolve) => (release = resolve))
		);
		onDisplayChange!();
		onDisplayChange!();
		onDisplayChange!();
		await waitFor(() => expect(fillOwnMonitor).toHaveBeenCalledTimes(1));
		release();
		await waitFor(() => expect(fillOwnMonitor).toHaveBeenCalledTimes(2));
		await new Promise((r) => setTimeout(r, 20));
		expect(fillOwnMonitor).toHaveBeenCalledTimes(2); // not three: the burst was coalesced
	});
});

describe('useStudioInit window-role reveal', () => {
	it('secondary overlay (?monitor=<key>): self-fits + reveals via fillOwnMonitor, not the primary path', async () => {
		monitorParamValue = 'DISPLAY3';
		const deps = makeDeps();
		renderHook(() => useStudioInit(deps));
		await waitFor(() => expect(fillOwnMonitor).toHaveBeenCalledWith('DISPLAY3'));
		expect(fillPrimaryMonitor).not.toHaveBeenCalled();
		expect(deps.syncPrimaryOverlays).not.toHaveBeenCalled();
	});

	it('primary main window: fills the primary monitor and reconciles overlays, no self-fit', async () => {
		const deps = makeDeps();
		renderHook(() => useStudioInit(deps));
		await waitFor(() => expect(deps.syncPrimaryOverlays).toHaveBeenCalled());
		expect(fillPrimaryMonitor).toHaveBeenCalled();
		expect(fillOwnMonitor).not.toHaveBeenCalled();
	});

	it('studio: neither overlay reveal path runs', async () => {
		const deps = makeDeps({ studio: true });
		renderHook(() => useStudioInit(deps));
		await waitFor(() => expect(deps.setMonitorOptions).toHaveBeenCalled());
		expect(fillOwnMonitor).not.toHaveBeenCalled();
		expect(fillPrimaryMonitor).not.toHaveBeenCalled();
		expect(deps.syncPrimaryOverlays).not.toHaveBeenCalled();
	});
});

describe('useStudioInit layout_changed routing', () => {
	const fire = (payload: unknown) => listeners.get('layout_changed')!({ payload });

	it("studio: ignores its own save's event, hands any OTHER writer's (or the watcher's) to the Canvas", async () => {
		const deps = makeDeps({ studio: true });
		renderHook(() => useStudioInit(deps));
		await waitFor(() => expect(listeners.has('layout_changed')).toBe(true));
		vi.mocked(deps.reloadLayout).mockClear();
		fire({ writer: 'studio' }); // its own preview write round-tripping
		expect(deps.onForeignLayoutChange).not.toHaveBeenCalled();
		fire({ writer: 'main' }); // an overlay's edit mode saved
		fire(null); // the file watcher: a hand edit
		expect(deps.onForeignLayoutChange).toHaveBeenCalledTimes(2);
		// The studio never auto-reloads here (it used to skip EVERY event because it is always editing).
		expect(deps.reloadLayout).not.toHaveBeenCalled();
	});

	it('overlay: reloads for other writers even while editing; the primary also reconciles overlays', async () => {
		let editing = false;
		const deps = makeDeps({ editMode: () => editing });
		renderHook(() => useStudioInit(deps));
		await waitFor(() => expect(deps.syncRects).toHaveBeenCalled());
		vi.mocked(deps.reloadLayout).mockClear();
		vi.mocked(deps.syncPrimaryOverlays).mockClear();
		editing = true;
		fire({ writer: 'main' }); // its own edit-mode write: already reflected
		expect(deps.reloadLayout).not.toHaveBeenCalled();
		// The studio saved this monitor: a stale overlay tree must not be written back over it, and
		// the overlay's own pending edit lands before the reload reads the file.
		let flushed!: () => void;
		vi.mocked(deps.flushPreviewWrite).mockImplementationOnce(
			() => new Promise<void>((resolve) => (flushed = resolve))
		);
		fire({ writer: 'studio' });
		await waitFor(() => expect(deps.flushPreviewWrite).toHaveBeenCalled());
		await Promise.resolve();
		expect(deps.reloadLayout).not.toHaveBeenCalled();
		flushed();
		await waitFor(() => expect(deps.syncPrimaryOverlays).toHaveBeenCalledTimes(1));
		editing = false;
		fire({ writer: 'main' });
		await waitFor(() => expect(deps.syncPrimaryOverlays).toHaveBeenCalledTimes(2));
		expect(deps.reloadLayout).toHaveBeenCalledTimes(2);
		expect(deps.onForeignLayoutChange).not.toHaveBeenCalled();
	});

	it('overlay out of edit mode: a still-pending preview lands before the reload reads the file', async () => {
		const deps = makeDeps({ editMode: () => false });
		renderHook(() => useStudioInit(deps));
		await waitFor(() => expect(deps.syncRects).toHaveBeenCalled());
		vi.mocked(deps.reloadLayout).mockClear();
		let flushed!: () => void;
		vi.mocked(deps.flushPreviewWrite).mockImplementationOnce(
			() => new Promise<void>((resolve) => (flushed = resolve))
		);
		fire({ writer: 'studio' });
		await waitFor(() => expect(deps.flushPreviewWrite).toHaveBeenCalled());
		await Promise.resolve();
		expect(deps.reloadLayout).not.toHaveBeenCalled();
		flushed();
		await waitFor(() => expect(deps.reloadLayout).toHaveBeenCalledTimes(1));
	});
});

describe('useStudioInit initial layout load', () => {
	it('retries a failed initial load, then surfaces the failure in the studio', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		try {
			const deps = makeDeps({ studio: true, reloadLayout: vi.fn(async () => false) });
			renderHook(() => useStudioInit(deps));
			await vi.waitFor(() => expect(deps.reloadLayout).toHaveBeenCalledTimes(1));
			await vi.advanceTimersByTimeAsync(1000);
			expect(deps.reloadLayout).toHaveBeenCalledTimes(2);
			expect(alert).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(3000);
			expect(deps.reloadLayout).toHaveBeenCalledTimes(3);
			expect(alert).toHaveBeenCalledTimes(1);
			expect(logClient).toHaveBeenCalledWith(
				'error',
				'layout',
				'initial layout load failed; edits will not be saved'
			);
		} finally {
			alert.mockRestore();
			vi.useRealTimers();
		}
	});

	it('stops retrying once a load succeeds, and an overlay never alerts', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		try {
			const reloadLayout = vi.fn(async () => false).mockResolvedValueOnce(false);
			const deps = makeDeps({ reloadLayout });
			renderHook(() => useStudioInit(deps));
			await vi.waitFor(() => expect(reloadLayout).toHaveBeenCalledTimes(1));
			reloadLayout.mockResolvedValue(true);
			await vi.advanceTimersByTimeAsync(5000);
			expect(reloadLayout).toHaveBeenCalledTimes(2);
			expect(alert).not.toHaveBeenCalled();
		} finally {
			alert.mockRestore();
			vi.useRealTimers();
		}
	});

	it('an overlay that exhausts its retries logs without alerting; unmount cancels retries', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		try {
			const overlay = makeDeps({ reloadLayout: vi.fn(async () => false) });
			renderHook(() => useStudioInit(overlay));
			await vi.waitFor(() => expect(overlay.reloadLayout).toHaveBeenCalledTimes(1));
			await vi.advanceTimersByTimeAsync(4000);
			expect(overlay.reloadLayout).toHaveBeenCalledTimes(3);
			expect(alert).not.toHaveBeenCalled();

			const studio = makeDeps({ studio: true, reloadLayout: vi.fn(async () => false) });
			const { unmount } = renderHook(() => useStudioInit(studio));
			await vi.waitFor(() => expect(studio.reloadLayout).toHaveBeenCalledTimes(1));
			unmount();
			await vi.advanceTimersByTimeAsync(4000);
			expect(studio.reloadLayout).toHaveBeenCalledTimes(1);
			expect(alert).not.toHaveBeenCalled();
		} finally {
			alert.mockRestore();
			vi.useRealTimers();
		}
	});
});

describe('useStudioInit resource ownership', () => {
	it('unsubscribes a late listener once and does not continue startup after unmount', async () => {
		let resolve!: (stop: () => void) => void;
		vi.mocked(listen).mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r;
				})
		);
		const deps = makeDeps({ studio: true });
		const { unmount } = renderHook(() => useStudioInit(deps));
		await waitFor(() => expect(resolve).toBeDefined());
		unmount();
		const stop = vi.fn();
		resolve(stop);
		await waitFor(() => expect(stop).toHaveBeenCalledOnce());
		expect(deps.updateWorkArea).not.toHaveBeenCalled();
	});
});
