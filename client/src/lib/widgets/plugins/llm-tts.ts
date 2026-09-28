// Outer-ring TTS adapter that prefers the configured PROVIDER's text-to-speech (OpenAI-style
// /audio/speech, synthesized server-side via `llm_synthesize`) and falls back to the browser's built-in
// Web Speech voice when no provider TTS is available (keyless/anthropic/ollama, no key, or a playback
// failure). Callers `speakSmart(text)` unconditionally; this picks the best path. Kept OUT of lib/tts.ts
// so that module stays a pure Web-Speech adapter (its unit tests need no Tauri import).

import { cancelSpeech, speak } from '../../tts';
import { llmSynthesize } from './llm-commands';

// One in-flight provider clip at a time (mirrors Web Speech's "newest wins"); tracked so a new clip or
// an explicit stop can cancel it and release the object URL.
let generation = 0;
let current: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

function stopAudio(): void {
	if (current) {
		current.pause();
		current = null;
	}
	if (currentUrl) {
		URL.revokeObjectURL(currentUrl);
		currentUrl = null;
	}
}

/** Play raw audio bytes (from `llm_synthesize`) via an <audio> element. Rejects if the runtime can't
 * play them, so `speakSmart` can fall back to the browser voice. */
async function playAudioBytes(bytes: number[], mime: string): Promise<void> {
	stopAudio();
	cancelSpeech(); // never let provider audio and a Web-Speech utterance overlap
	const blob = new Blob([new Uint8Array(bytes)], { type: mime || 'audio/mpeg' });
	const url = URL.createObjectURL(blob);
	currentUrl = url;
	const audio = new Audio(url);
	current = audio;
	const release = (): void => {
		if (current === audio) stopAudio();
	};
	audio.onended = release;
	audio.onerror = release;
	await audio.play(); // rejects on autoplay/codec failure → caller falls back
}

/** Speak `text` aloud: provider TTS when it's configured + reachable, else the browser's Web Speech
 * voice. Best-effort and never throws — a missing key / unsupported provider / playback error all fall
 * back to the browser voice. */
export async function speakSmart(text: string): Promise<void> {
	const t = text.trim();
	if (!t) return;
	stopSpeaking();
	const request = generation;
	try {
		const { audio, mime } = await llmSynthesize(t);
		if (request !== generation) return;
		await playAudioBytes(audio, mime);
	} catch {
		// No provider TTS (keyless/unsupported/no key) or a playback failure → browser fallback.
		if (request !== generation) return;
		stopAudio();
		speak(t);
	}
}

/** Stop any in-progress speech (provider clip + Web Speech). */
export function stopSpeaking(): void {
	generation++;
	stopAudio();
	cancelSpeech();
}
