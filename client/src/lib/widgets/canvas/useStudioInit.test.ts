// The init must make every window role reveal itself from its OWN webview: a secondary overlay
// (?monitor=<key>) self-fits + shows via fillOwnMonitor — the spawn-side `tauri://created` setup
// dies with its creator when an empty-primary `main` self-destructs (renderer reclaim), which left
// secondaries permanently invisible. The primary keeps its fill/reconcile path.
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TelemetryHub } from '../../core/telemetry';
import type { StudioInitDeps } from './useStudioInit';
import { useStudioInit } from './useStudioInit';

const fillOwnMonitor = vi.fn((key: string) => Promise.resolve(void key));
const fillPrimaryMonitor = vi.fn(() => Promise.resolve());
const setMainWindowVisible = vi.fn((visible: boolean) => Promise.resolve(void visible));
let monitorParamValue: string | null = null;

vi.mock('../../overlay', () => ({
	fillOwnMonitor: (key: string) => fillOwnMonitor(key),
	fillPrimaryMonitor: () => fillPrimaryMonitor(),
	setMainWindowVisible: (v: boolean) => setMainWindowVisible(v),
	monitorParam: () => monitorParamValue,
	listThemes: vi.fn(async () => []),
	openStudio: vi.fn(() => Promise.resolve()),
	studioMonitorOptions: vi.fn(async () => []),
	watchDisplayChanges: vi.fn(() => () => undefined)
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
		...overrides
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	monitorParamValue = null;
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
