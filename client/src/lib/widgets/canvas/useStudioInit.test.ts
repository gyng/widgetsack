// The init must make every window role reveal itself from its OWN webview: a secondary overlay
// (?monitor=<key>) self-fits + shows via fillOwnMonitor — the spawn-side `tauri://created` setup
// dies with its creator when an empty-primary `main` self-destructs (renderer reclaim), which left
// secondaries permanently invisible. The primary keeps its fill/reconcile path.
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TelemetryHub } from '../../core/telemetry';
import type { StudioInitDeps } from './useStudioInit';
import { useStudioInit } from './useStudioInit';
import { overlayDrift } from '../../overlay';

const fillOwnMonitor = vi.fn((key: string): Promise<void> => Promise.resolve(void key));
const fillPrimaryMonitor = vi.fn(() => Promise.resolve());
const setMainWindowVisible = vi.fn((visible: boolean) => Promise.resolve(void visible));
let monitorParamValue: string | null = null;
/** The topology-change callback the hook handed to watchDisplayChanges (the refit trigger). */
let onDisplayChange: (() => void) | null = null;
/** The drift probe handed alongside it (overlays only). */
let driftProbe: (() => Promise<string | null>) | null = null;
/** The scale-change callback the hook registered via onOwnScaleChanged (overlays only). */
let onScaleChange: (() => void) | null = null;

vi.mock('../../overlay', () => ({
	fillOwnMonitor: (key: string) => fillOwnMonitor(key),
	fillPrimaryMonitor: () => fillPrimaryMonitor(),
	setMainWindowVisible: (v: boolean) => setMainWindowVisible(v),
	monitorParam: () => monitorParamValue,
	listThemes: vi.fn(async () => []),
	logClient: vi.fn(),
	onOwnScaleChanged: vi.fn(async (cb: () => void) => {
		onScaleChange = cb;
		return () => undefined;
	}),
	openStudio: vi.fn(() => Promise.resolve()),
	overlayDrift: vi.fn(async () => null),
	studioMonitorOptions: vi.fn(async () => []),
	watchDisplayChanges: vi.fn((cb: () => void, probe?: () => Promise<string | null>) => {
		onDisplayChange = cb;
		driftProbe = probe ?? null;
		return () => undefined;
	})
}));
vi.mock('../../core/plugin', () => ({
	startAllSources: vi.fn(async () => () => undefined)
}));
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(async () => () => undefined)
}));

function makeDeps(overrides: Partial<StudioInitDeps> = {}): StudioInitDeps {
	return {
		studio: false,
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
		clearPreviewWrite: vi.fn(),
		reapplyPresentation: vi.fn(() => Promise.resolve()),
		...overrides
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	monitorParamValue = null;
	onDisplayChange = null;
	driftProbe = null;
	onScaleChange = null;
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
		// The taskbar inset is re-read after the move: a window that moves without resizing fires
		// no `resize`, which was the only other trigger, leaving the flow root rebased on stale data.
		await waitFor(() => expect(deps.updateWorkArea).toHaveBeenCalledTimes(1));
		// And the presentation (click-through / z-order for the CURRENT edit state) is re-applied:
		// the fit is geometry only, and forcing click-through there broke edit mode on a refit.
		await waitFor(() => expect(deps.reapplyPresentation).toHaveBeenCalledTimes(1));
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
