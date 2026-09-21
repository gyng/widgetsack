// Outer-ring adapter + store for the background app-update check (widgetsack/src/update.rs). The
// backend keeps the last result and pushes each new one as an `app_update` event; this module
// mirrors that into one external store so the About tab and the nav-rail badge share it. The
// first subscriber starts the watch (idempotent): read the persisted result via `get_app_update`,
// then listen for later checks. Tauri stays at this edge; the shapes + labels are pure
// (core/updateNotice.ts).
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createStore, useStore } from '../stores/createStore';
import {
	appUpdateFromWire,
	DEFAULT_APP_PREFS,
	isProjectUrl,
	type AppPrefs,
	type AppUpdate,
	type AppUpdateWire
} from './core/updateNotice';
import { COMMANDS, EVENTS } from './bridge/contract';

/** The last known check result (`null` until one completes). */
export const appUpdateStore = createStore<AppUpdate | null>(null);

let watchStarted = false;

/** Start mirroring the backend's result into `appUpdateStore` (once per window). Best-effort:
 * outside Tauri both calls reject and the store just stays `null`. */
export function ensureAppUpdateWatch(): void {
	if (watchStarted) return;
	watchStarted = true;
	invoke<AppUpdateWire | null>(COMMANDS.getAppUpdate)
		.then((wire) => {
			// Don't clobber a newer event that raced ahead of the initial read.
			if (appUpdateStore.getSnapshot() === null) appUpdateStore.set(appUpdateFromWire(wire));
		})
		.catch(() => undefined);
	listen<AppUpdateWire>(EVENTS.appUpdate, (ev) => {
		appUpdateStore.set(appUpdateFromWire(ev.payload));
	}).catch(() => undefined);
}

/** Test seam: forget that the watch started (so a fresh test can re-arm it). */
export function resetAppUpdateWatchForTests(): void {
	watchStarted = false;
	appUpdateStore.set(null);
}

/** Subscribe a component to the last known update result, arming the watch on first use. */
export function useAppUpdate(): AppUpdate | null {
	ensureAppUpdateWatch();
	return useStore(appUpdateStore);
}

/** The persisted app prefs (defaults outside Tauri / on failure). */
export async function getAppPrefs(): Promise<AppPrefs> {
	try {
		return (await invoke<AppPrefs>(COMMANDS.getAppPrefs)) ?? DEFAULT_APP_PREFS;
	} catch {
		return DEFAULT_APP_PREFS;
	}
}

/** Turn the background update check on/off (persisted by the backend; enabling runs a check at
 * once, whose result arrives through the `app_update` event). Returns the saved prefs. */
export async function setUpdateCheck(enabled: boolean): Promise<AppPrefs> {
	return (await invoke<AppPrefs>(COMMANDS.setUpdateCheck, { enabled })) ?? DEFAULT_APP_PREFS;
}

/** Open a project release page in the default browser (backend `open_url`, ShellExecuteW). The
 * URL is checked here too so a non-project URL never even reaches the bridge. Resolves whether
 * the open was attempted successfully. */
export async function openReleasePage(url: string): Promise<boolean> {
	if (!isProjectUrl(url)) return false;
	try {
		await invoke(COMMANDS.openUrl, { url });
		return true;
	} catch {
		return false;
	}
}
