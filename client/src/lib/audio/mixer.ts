import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../bridge/contract';
export type AudioSession = { id: string; name: string; level: number; muted: boolean };
export type MixerSnapshot = {
	sessions: AudioSession[];
	microphone: { level: number; muted: boolean } | null;
	sessionError?: string | null;
};
export const getAudioMixer = (): Promise<MixerSnapshot> => invoke(COMMANDS.getAudioMixer);
export const setAudioSession = (
	id: string,
	level: number | null,
	muted: boolean | null
): Promise<void> => invoke(COMMANDS.setAudioSession, { id, level, muted });
export const setMicrophoneMute = (muted: boolean): Promise<void> =>
	invoke(COMMANDS.setMicrophoneMute, { muted });
