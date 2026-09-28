import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from './contract';

// ---- sacks: shareable widget+theme bundles in a `sacks/` folder (Rust read/write, no picker) ----

/** The names of saved sacks (file stems of `sacks/*.sack.json`). */
export async function listSacks(): Promise<string[]> {
	try {
		return await invoke<string[]>(COMMANDS.listSacks);
	} catch (err) {
		console.warn('list_sacks failed', err);
		return [];
	}
}

/** The raw JSON of sack `name`, or null if it doesn't exist / fails to read. */
export async function readSack(name: string): Promise<string | null> {
	try {
		return await invoke<string | null>(COMMANDS.readSack, { name });
	} catch (err) {
		console.warn('read_sack failed', err);
		return null;
	}
}

/** Write sack `name` with the given JSON; returns the absolute path written (or null on failure). */
export async function writeSack(name: string, contents: string): Promise<string | null> {
	try {
		return await invoke<string>(COMMANDS.writeSack, { name, contents });
	} catch (err) {
		console.warn('write_sack failed', err);
		return null;
	}
}
