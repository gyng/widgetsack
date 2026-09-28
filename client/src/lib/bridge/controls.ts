import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from './contract';

/** Read the saved control remaps (`controls.json`), or null if none/failed. The frontend validates
 * the JSON via core/controls.ts `parseControlOverrides`; this is just the Tauri I/O edge. */
export async function loadControls(): Promise<string | null> {
	try {
		return await invoke<string | null>(COMMANDS.loadControls);
	} catch (err) {
		console.warn('load_controls failed', err);
		return null;
	}
}

/** Persist the control remaps JSON (`{ version, overrides }`). */
export async function saveControls(contents: string): Promise<void> {
	try {
		await invoke(COMMANDS.saveControls, { contents });
	} catch (err) {
		console.warn('save_controls failed', err);
	}
}
