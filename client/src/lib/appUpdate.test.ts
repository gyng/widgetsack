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
		const { result } = renderHook(() => useAppUpdate());
		expect(result.current).toBeNull();
		expect(invoke).toHaveBeenCalledWith('get_app_update');
		await act(async () => eventHandler()({ payload: wire(true) }));
		expect(result.current?.latest).toBe('0.0.56');
		act(() => resetAppUpdateWatchForTests());
		expect(result.current).toBeNull();
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
		expect(await mod.getAppPrefs()).toEqual({ update_check: false });
		invoke.mockRejectedValueOnce(new Error('no tauri'));
		expect(await mod.getAppPrefs()).toEqual({ update_check: false });
	});

	it('setUpdateCheck writes through and returns the saved prefs (defaults on a null reply)', async () => {
		const mod = await load();
		invoke.mockResolvedValueOnce({ update_check: true });
		expect(await mod.setUpdateCheck(true)).toEqual({ update_check: true });
		expect(invoke).toHaveBeenLastCalledWith('set_update_check', { enabled: true });
		invoke.mockResolvedValueOnce(null);
		expect(await mod.setUpdateCheck(false)).toEqual({ update_check: false });
	});
});
