import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from './contract';

// --- app update check ---
// Manual check (About panel): the backend (command/application.rs check_app_update) asks GitHub for the latest
// published release and compares it to the running version — the app ships no auto-updater.

export type AppUpdate = {
	current: string;
	latest: string;
	url: string;
	updateAvailable: boolean;
};

/** Check GitHub for a newer release. Throws on network/parse failure (the caller surfaces it). */
export async function checkAppUpdate(): Promise<AppUpdate> {
	const r = await invoke<{
		current: string;
		latest: string;
		url: string;
		update_available: boolean;
	}>(COMMANDS.checkAppUpdate);
	return { current: r.current, latest: r.latest, url: r.url, updateAvailable: r.update_available };
}

// --- launch at login ---
// Backed by tauri-plugin-autostart, but routed through our own commands (autostart.rs) so a durable
// preference is persisted alongside the OS Run key — the Run key alone doesn't survive a manual
// install (the NSIS uninstaller wipes it). Neither helper throws (off-Windows / unavailable /
// a denied registry write): the result carries the re-read state plus the failure reason, so the
// Settings toggle can SHOW why nothing changed instead of silently reverting.

/** The outcome of an autostart read/write: the state as re-read from the OS, and the reason if the
 * requested change (or the read) failed. */
export type AutostartResult = { enabled: boolean; error: string | null };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Whether the app is registered to launch at login (false + the reason when unreadable). */
export async function isAutostartEnabled(): Promise<AutostartResult> {
	try {
		return { enabled: await invoke<boolean>(COMMANDS.autostartGet), error: null };
	} catch (err) {
		console.warn('autostart get failed', err);
		return { enabled: false, error: errorText(err) };
	}
}

/** Enable/disable launch at login; returns the resulting (re-read) state. When the write fails the
 * result re-reads the actual state and carries the failure reason. */
export async function setAutostart(enabled: boolean): Promise<AutostartResult> {
	try {
		return { enabled: await invoke<boolean>(COMMANDS.autostartSet, { enabled }), error: null };
	} catch (err) {
		console.warn('autostart toggle failed', err);
		const reread = await isAutostartEnabled();
		return { enabled: reread.enabled, error: errorText(err) };
	}
}
