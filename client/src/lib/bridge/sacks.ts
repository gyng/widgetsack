import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from './contract';
import { DASHBOARD_SACKS } from '../core/dashboardSacks';

// ---- sacks: shareable widget+theme bundles in a `sacks/` folder (Rust read/write, no picker) ----

/** The names of saved sacks (file stems of `sacks/*.sack.json`). */
export async function listSacks(requireComplete = false): Promise<string[]> {
	try {
		return [...Object.keys(DASHBOARD_SACKS), ...(await invoke<string[]>(COMMANDS.listSacks))];
	} catch (err) {
		if (requireComplete) throw err;
		console.warn('list_sacks failed', err);
		return Object.keys(DASHBOARD_SACKS);
	}
}

/** The raw JSON of sack `name`, or null if it doesn't exist / fails to read. */
export async function readSack(name: string): Promise<string | null> {
	if (Object.hasOwn(DASHBOARD_SACKS, name)) return JSON.stringify(DASHBOARD_SACKS[name]);
	try {
		return await invoke<string | null>(COMMANDS.readSack, { name });
	} catch (err) {
		console.warn('read_sack failed', err);
		return null;
	}
}

/** Write sack `name` with the given JSON; returns the absolute path written (or null on failure). */
export async function writeSack(
	name: string,
	contents: string,
	overwrite = true
): Promise<string | null> {
	try {
		return await invoke<string>(COMMANDS.writeSack, { name, contents, overwrite });
	} catch (err) {
		console.warn('write_sack failed', err);
		return null;
	}
}
