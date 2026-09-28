import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from './contract';
import { logClient } from './logging';

// One backup per session: every parse-failure path funnels here, and the FIRST one wins — later
// calls would only re-copy the same bytes (or, worse, a default layout already saved over them).
let layoutBackupRequested = false;

/** Ask the backend to copy the current widgets.json aside (`widgets.json.bad-<ts>`) because this
 *  session failed to PARSE it — called BEFORE the in-memory default layout can be saved over the
 *  original, so whatever was hand-recoverable in it survives. Best-effort and once per session. */
export function requestLayoutBackup(): void {
	if (layoutBackupRequested) return;
	layoutBackupRequested = true;
	invoke<string | null>(COMMANDS.backupLayout)
		.then((path) => {
			if (path) logClient('warn', 'layout', `unparseable widgets.json backed up to ${path}`);
		})
		.catch((err) => logClient('error', 'layout', `layout backup failed: ${String(err)}`));
}

/** Read the saved layout (`widgets.json`) raw JSON, or null if none/failed. The overlay's
 * DragSnapLayer parses it (core/migration.ts) to find `zone` widgets. Same file the layout uses. */
export async function loadLayoutRaw(): Promise<string | null> {
	try {
		return await invoke<string | null>(COMMANDS.loadLayout);
	} catch (err) {
		console.warn('load_layout failed', err);
		return null;
	}
}

/** The names of saved layout profiles (file stems of `layouts/*.layout.json`). */
export async function listLayouts(): Promise<string[]> {
	try {
		return await invoke<string[]>(COMMANDS.listLayouts);
	} catch (err) {
		console.warn('list_layouts failed', err);
		return [];
	}
}

/** The raw JSON of saved layout `name`, or null if it doesn't exist / fails to read. */
export async function readLayout(name: string): Promise<string | null> {
	try {
		return await invoke<string | null>(COMMANDS.readLayout, { name });
	} catch (err) {
		console.warn('read_layout failed', err);
		return null;
	}
}

/** Save the current monitor's layout as profile `name`; returns the path written (or null). */
export async function saveLayoutAs(name: string, contents: string): Promise<string | null> {
	try {
		return await invoke<string>(COMMANDS.saveLayoutAs, { name, contents });
	} catch (err) {
		console.warn('save_layout_as failed', err);
		return null;
	}
}

/** Delete saved layout `name` (idempotent). Returns true on success. */
export async function deleteLayout(name: string): Promise<boolean> {
	try {
		await invoke(COMMANDS.deleteLayout, { name });
		return true;
	} catch (err) {
		console.warn('delete_layout failed', err);
		return false;
	}
}
