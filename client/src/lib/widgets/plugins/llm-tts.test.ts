import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the two outer-ring deps: the provider-TTS Tauri command and the Web-Speech adapter (lib/tts).
// The smart-fallback decision logic (provider clip → else browser voice) and the playback bookkeeping
// (object-URL create/revoke, single in-flight clip) are what we assert.
const llmSynthesize = vi.fn();
const speak = vi.fn();
const cancelSpeech = vi.fn();
vi.mock('./llm-commands', () => ({ llmSynthesize: (t: string) => llmSynthesize(t) }));
vi.mock('../../tts', () => ({
	speak: (t: string) => speak(t),
	cancelSpeech: () => cancelSpeech()
}));

import { speakSmart, stopSpeaking } from './llm-tts';

// A controllable fake <audio>. play() resolves/rejects per the test; we record pause + the src URL.
let audios: FakeAudio[] = [];
class FakeAudio {
	src: string;
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	paused = false;
	playResult: Promise<void> = Promise.resolve();
	constructor(src: string) {
		this.src = src;
		audios.push(this);
	}
	play(): Promise<void> {
		return this.playResult;
	}
	pause(): void {
		this.paused = true;
	}
}

const revoked: string[] = [];

beforeEach(() => {
	audios = [];
	revoked.length = 0;
	vi.stubGlobal('Audio', FakeAudio);
	vi.stubGlobal(
		'Blob',
		class {
			constructor(
				public parts: unknown[],
				public opts: { type?: string }
			) {}
		}
	);
	let n = 0;
	vi.stubGlobal('URL', {
		createObjectURL: vi.fn(() => `blob:url-${++n}`),
		revokeObjectURL: vi.fn((u: string) => revoked.push(u))
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe('speakSmart', () => {
	it('does nothing for blank text', async () => {
		await speakSmart('   ');
		expect(llmSynthesize).not.toHaveBeenCalled();
		expect(speak).not.toHaveBeenCalled();
	});

	it('plays the provider clip when synthesis succeeds (no browser fallback)', async () => {
		llmSynthesize.mockResolvedValue({ audio: [1, 2, 3], mime: 'audio/mpeg' });
		await speakSmart('hello');
		expect(llmSynthesize).toHaveBeenCalledWith('hello');
		expect(cancelSpeech).toHaveBeenCalled(); // never overlap provider audio + web speech
		expect(audios).toHaveLength(1);
		expect(audios[0]!.src).toBe('blob:url-1');
		expect(speak).not.toHaveBeenCalled();
	});

	it('falls back to the browser voice when synthesis is unavailable', async () => {
		llmSynthesize.mockRejectedValue(new Error('no provider tts'));
		await speakSmart('hi there');
		expect(speak).toHaveBeenCalledWith('hi there');
		expect(audios).toHaveLength(0);
	});

	it('falls back to the browser voice when playback rejects (autoplay/codec)', async () => {
		llmSynthesize.mockResolvedValue({ audio: [9], mime: '' });
		// Make the constructed audio reject on play().
		const realCtor = FakeAudio;
		vi.stubGlobal(
			'Audio',
			class extends realCtor {
				constructor(src: string) {
					super(src);
					this.playResult = Promise.reject(new Error('autoplay blocked'));
				}
			}
		);
		await speakSmart('hi');
		expect(speak).toHaveBeenCalledWith('hi');
	});

	it('stops the previous clip and revokes its URL when a new clip starts', async () => {
		llmSynthesize.mockResolvedValue({ audio: [1], mime: 'audio/mpeg' });
		await speakSmart('first');
		await speakSmart('second'); // stopAudio() pauses #1 + revokes its url
		expect(audios).toHaveLength(2);
		expect(audios[0]!.paused).toBe(true);
		expect(revoked).toContain('blob:url-1');
	});

	it('releases the clip when it ends (onended)', async () => {
		llmSynthesize.mockResolvedValue({ audio: [1], mime: 'audio/mpeg' });
		await speakSmart('clip');
		const a = audios[0]!;
		a.onended!(); // playback finished
		expect(a.paused).toBe(true);
		expect(revoked).toContain('blob:url-1');
	});
});

describe('stopSpeaking', () => {
	it('stops a playing provider clip and cancels web speech', async () => {
		llmSynthesize.mockResolvedValue({ audio: [1], mime: 'audio/mpeg' });
		await speakSmart('playing');
		cancelSpeech.mockClear();
		stopSpeaking();
		expect(audios[0]!.paused).toBe(true);
		expect(revoked).toContain('blob:url-1');
		expect(cancelSpeech).toHaveBeenCalled();
	});

	it('is a safe no-op when nothing is playing', () => {
		expect(() => stopSpeaking()).not.toThrow();
		expect(cancelSpeech).toHaveBeenCalled();
	});
});
