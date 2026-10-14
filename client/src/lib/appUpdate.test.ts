import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Outer-ring adapter for the backend's background update check (widgetsack/src/update.rs). Mock
// @tauri-apps/api's invoke/listen so the persisted-read + live-event mirroring can be driven
// without a Tauri runtime. The module is re-imported per test so the once-only watch re-arms.

const invoke = vi.fn();
const listen = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listen(...a) }));

type Mod = typeof import('./appUpdate');
const load = async (): Promise<Mod> => {
	vi.resetModules();
	return import('./appUpdate');
};

const wire = (update_available: boolean) => ({
	current: '0.0.55',
	latest: '0.0.56',
	url: 'https://github.com/gyng/widgetsack/releases/tag/v0.0.56',
	update_available
});

// The `app_update` handler `listen` was registered with (the store's live feed).
const eventHandler = (): ((ev: { payload: unknown }) => void) => {
	const call = listen.mock.calls.find((c) => c[0] === 'app_update');
	if (!call) throw new Error('app_update listener not registered');
	return call[1] as (ev: { payload: unknown }) => void;
};

beforeEach(() => {
	vi.clearAllMocks();
	listen.mockResolvedValue(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('ensureAppUpdateWatch', () => {
	it('reads the persisted result once, then mirrors later events into the store', async () => {
		invoke.mockResolvedValueOnce(wire(false));
		const { ensureAppUpdateWatch, appUpdateStore } = await load();
		ensureAppUpdateWatch();
		ensureAppUpdateWatch(); // idempotent: one read, one listener
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke).toHaveBeenCalledWith('get_app_update');
		expect(listen).toHaveBeenCalledTimes(1);
		await act(async () => undefined);
		expect(appUpdateStore.getSnapshot()).toEqual({
			current: '0.0.55',
			latest: '0.0.56',
			url: 'https://github.com/gyng/widgetsack/releases/tag/v0.0.56',
			updateAvailable: false
		});
		eventHandler()({ payload: wire(true) });
		expect(appUpdateStore.getSnapshot()?.updateAvailable).toBe(true);
	});

	it('does not let a slow initial read overwrite an event that arrived first', async () => {
		let resolveRead: ((v: unknown) => void) | undefined;
		invoke.mockImplementationOnce(() => new Promise((r) => (resolveRead = r)));
		const { ensureAppUpdateWatch, appUpdateStore } = await load();
		ensureAppUpdateWatch();
		eventHandler()({ payload: wire(true) }); // the live event lands before the read resolves
		await act(async () => resolveRead?.(wire(false)));
		expect(appUpdateStore.getSnapshot()?.updateAvailable).toBe(true);
	});

	it('leaves the store null when the bridge is unavailable (outside Tauri)', async () => {
		invoke.mockRejectedValueOnce(new Error('no tauri'));
		listen.mockRejectedValueOnce(new Error('no tauri'));
		const { ensureAppUpdateWatch, appUpdateStore } = await load();
		expect(() => ensureAppUpdateWatch()).not.toThrow();
		await act(async () => undefined);
		expect(appUpdateStore.getSnapshot()).toBeNull();
	});
});

describe('useAppUpdate', () => {
	it('arms the watch and re-renders on store changes; the test seam resets both', async () => {
		invoke.mockResolvedValueOnce(null);
		const { useAppUpdate, resetAppUpdateWatchForTests } = await load();
		const { result, unmount } = renderHook(() => useAppUpdate());
		expect(result.current).toBeNull();
		expect(invoke).toHaveBeenCalledWith('get_app_update');
		await act(async () => eventHandler()({ payload: wire(true) }));
		expect(result.current?.latest).toBe('0.0.56');
		unmount();
		resetAppUpdateWatchForTests();
		const { appUpdateStore } = await import('./appUpdate');
		expect(appUpdateStore.getSnapshot()).toBeNull();
	});
});

describe('openReleasePage', () => {
	it('invokes open_url for a project URL and reports the outcome', async () => {
		invoke.mockResolvedValueOnce(undefined);
		const { openReleasePage } = await load();
		await expect(
			openReleasePage('https://github.com/gyng/widgetsack/releases/tag/v0.0.56')
		).resolves.toBe(true);
		expect(invoke).toHaveBeenCalledWith('open_url', {
			url: 'https://github.com/gyng/widgetsack/releases/tag/v0.0.56'
		});
		invoke.mockRejectedValueOnce(new Error('ShellExecuteW failed'));
		await expect(openReleasePage('https://github.com/gyng/widgetsack')).resolves.toBe(false);
	});

	it('refuses a non-project URL without touching the bridge', async () => {
		const { openReleasePage } = await load();
		await expect(openReleasePage('https://evil.example/')).resolves.toBe(false);
		expect(invoke).not.toHaveBeenCalled();
	});
});

describe('app prefs (background update check opt-in)', () => {
	it('reads the persisted prefs and falls back to the opt-out defaults outside Tauri', async () => {
		const mod = await load();
		invoke.mockResolvedValueOnce({ update_check: true });
		expect(await mod.getAppPrefs()).toEqual({ update_check: true });
		expect(invoke).toHaveBeenLastCalledWith('get_app_prefs');
		invoke.mockResolvedValueOnce(null); // an older backend with no prefs command payload
		expect(await mod.getAppPrefs()).toEqual({ update_check: false, edit_hotkey: 'Ctrl+Alt+E' });
		invoke.mockRejectedValueOnce(new Error('no tauri'));
		expect(await mod.getAppPrefs()).toEqual({ update_check: false, edit_hotkey: 'Ctrl+Alt+E' });
	});

	it('setUpdateCheck writes through and returns the saved prefs (defaults on a null reply)', async () => {
		const mod = await load();
		invoke.mockResolvedValueOnce({ update_check: true });
		expect(await mod.setUpdateCheck(true)).toEqual({ update_check: true });
		expect(invoke).toHaveBeenLastCalledWith('set_update_check', { enabled: true });
		invoke.mockResolvedValueOnce(null);
		expect(await mod.setUpdateCheck(false)).toEqual({
			update_check: false,
			edit_hotkey: 'Ctrl+Alt+E'
		});
	});
});

describe('edit hotkey', () => {
	const status = (hotkey: string, active = true, error: string | null = null) => ({
		hotkey,
		active,
		error
	});

	it('reads the status, or null outside Tauri / on a null reply', async () => {
		const mod = await load();
		invoke.mockResolvedValueOnce(status('Win+Alt+E'));
		expect(await mod.getEditHotkey()).toEqual(status('Win+Alt+E'));
		expect(invoke).toHaveBeenLastCalledWith('get_edit_hotkey');
		invoke.mockResolvedValueOnce(null);
		expect(await mod.getEditHotkey()).toBeNull();
		invoke.mockRejectedValueOnce(new Error('no tauri'));
		expect(await mod.getEditHotkey()).toBeNull();
	});

	it('setEditHotkey sends the accelerator and surfaces a rejection', async () => {
		const mod = await load();
		invoke.mockResolvedValueOnce(status('Off', false));
		expect(await mod.setEditHotkey('Off')).toEqual(status('Off', false));
		expect(invoke).toHaveBeenLastCalledWith('set_edit_hotkey', { hotkey: 'Off' });
		invoke.mockRejectedValueOnce('unrecognised shortcut');
		await expect(mod.setEditHotkey('Ctrl+Alt+Nope')).rejects.toBe('unrecognised shortcut');
	});

	it('useEditExitKeys names the registered chord, Ctrl+E when none is active', async () => {
		const mod = await load();
		invoke.mockResolvedValueOnce(status('Win+Alt+E'));
		const on = renderHook(() => mod.useEditExitKeys());
		expect(on.result.current).toBe('Ctrl+Alt+E'); // before the read lands
		await act(async () => undefined);
		expect(on.result.current).toBe('Win+Alt+E');

		invoke.mockResolvedValueOnce(status('Ctrl+Alt+E', false, 'taken'));
		const failed = renderHook(() => mod.useEditExitKeys());
		await act(async () => undefined);
		expect(failed.result.current).toBe('Ctrl+E');
	});

	it('useEditExitKeys reads nothing while disabled, then re-reads when enabled', async () => {
		const mod = await load();
		const view = renderHook(({ on }) => mod.useEditExitKeys(on), {
			initialProps: { on: false }
		});
		await act(async () => undefined);
		expect(invoke).not.toHaveBeenCalled();
		invoke.mockResolvedValueOnce(status('Off', false));
		view.rerender({ on: true });
		await act(async () => undefined);
		expect(invoke).toHaveBeenCalledWith('get_edit_hotkey');
		expect(view.result.current).toBe('Ctrl+E');
	});

	it('useEditExitKeys ignores a read that lands after unmount', async () => {
		const mod = await load();
		let resolve!: (s: unknown) => void;
		invoke.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
		const view = renderHook(() => mod.useEditExitKeys());
		view.unmount();
		await act(async () => resolve(status('Win+Alt+E')));
		expect(view.result.current).toBe('Ctrl+Alt+E');
	});
});
