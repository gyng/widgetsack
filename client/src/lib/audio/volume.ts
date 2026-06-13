// Outer-ring adapter (AGENTS.md §5) for the Volume widget: read/set the system master volume + mute.
// Tauri lives here, never in the meter or core/. Command names + the AudioVolume shape mirror
// widgetsack/src/audio.rs (Core Audio IAudioEndpointVolume).

import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../bridge/contract';

/** System master volume snapshot. Mirrors `AudioVolume` in widgetsack/src/audio.rs. */
export type AudioVolume = { level: number; muted: boolean };

/** Read the master volume + mute, or null (off-Windows / failure). */
export async function getAudioVolume(): Promise<AudioVolume | null> {
	try {
		return (await invoke<AudioVolume | null>(COMMANDS.getAudioVolume)) ?? null;
	} catch {
		return null;
	}
}

/** Set the master volume (scalar 0..1). Resolves false on failure. */
export async function setAudioVolume(level: number): Promise<boolean> {
	try {
		await invoke(COMMANDS.setAudioVolume, { level });
		return true;
	} catch (err) {
		console.warn('set_audio_volume failed', err);
		return false;
	}
}

/** Set the mute state. Resolves false on failure. */
export async function setAudioMute(muted: boolean): Promise<boolean> {
	try {
		await invoke(COMMANDS.setAudioMute, { muted });
		return true;
	} catch (err) {
		console.warn('set_audio_mute failed', err);
		return false;
	}
}
