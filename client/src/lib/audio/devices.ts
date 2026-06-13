// Outer-ring adapter (AGENTS.md §5) for the Audio Switcher widget: list output devices, read the
// current default, and switch it. Tauri lives here, never in the meter or core/. Command names mirror
// widgetsack/src/audio.rs. Setting the default uses the IPolicyConfig COM path on the backend.

import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../bridge/contract';
import type { AudioDevice } from '../core/audioDevices';

/** All output (render) endpoints, friendly-named. Empty off-Windows / on failure. */
export async function listAudioOutputs(): Promise<AudioDevice[]> {
	try {
		return (await invoke<AudioDevice[]>(COMMANDS.listAudioOutputs)) ?? [];
	} catch {
		return [];
	}
}

/** The current default render endpoint's id, or null (unknown / off-Windows). */
export async function getDefaultAudioOutput(): Promise<string | null> {
	try {
		return (await invoke<string | null>(COMMANDS.defaultAudioOutput)) ?? null;
	} catch {
		return null;
	}
}

/** Make `id` the default output for all roles. Resolves to true on success, false on failure (so the
 * widget can roll back its optimistic highlight). */
export async function setDefaultAudioOutput(id: string): Promise<boolean> {
	try {
		await invoke(COMMANDS.setDefaultAudioOutput, { id });
		return true;
	} catch (err) {
		console.warn('set_default_audio_output failed', err);
		return false;
	}
}
