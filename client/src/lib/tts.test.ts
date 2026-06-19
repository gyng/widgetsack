import { describe, it, expect, vi, afterEach } from 'vitest';
import { cancelSpeech, listVoices, speak, ttsAvailable } from './tts';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('tts', () => {
	it('degrades gracefully when speechSynthesis is unavailable', () => {
		// happy-dom has no speechSynthesis by default.
		expect(ttsAvailable()).toBe(false);
		// these must not throw
		expect(() => speak('hello')).not.toThrow();
		expect(() => cancelSpeech()).not.toThrow();
		expect(listVoices()).toEqual([]);
	});

	it('speaks via the API when available, clamping rate and skipping blank text', () => {
		const spoken: { text: string; rate: number }[] = [];
		class FakeUtterance {
			text: string;
			rate = 1;
			pitch = 1;
			volume = 1;
			voice: unknown = null;
			constructor(t: string) {
				this.text = t;
			}
		}
		const synth = {
			cancel: vi.fn(),
			getVoices: () => [],
			speak: vi.fn((u: FakeUtterance) => spoken.push({ text: u.text, rate: u.rate }))
		};
		vi.stubGlobal('speechSynthesis', synth);
		vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);

		expect(ttsAvailable()).toBe(true);
		speak('  blank skip test  ', { rate: 9 }); // rate clamped to 2
		expect(synth.cancel).toHaveBeenCalled();
		expect(spoken).toEqual([{ text: 'blank skip test', rate: 2 }]);

		speak('   '); // blank -> no new utterance
		expect(spoken).toHaveLength(1);
	});

	it('selects a matching voice and lists voice names; cancelSpeech cancels', () => {
		class FakeUtterance {
			text: string;
			rate = 1;
			pitch = 1;
			volume = 1;
			voice: { name: string } | null = null;
			constructor(t: string) {
				this.text = t;
			}
		}
		const voices = [{ name: 'Alice' }, { name: 'Bob' }];
		const spoken: FakeUtterance[] = [];
		const synth = {
			cancel: vi.fn(),
			getVoices: () => voices,
			speak: vi.fn((u: FakeUtterance) => spoken.push(u))
		};
		vi.stubGlobal('speechSynthesis', synth);
		vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);

		expect(listVoices()).toEqual(['Alice', 'Bob']);

		speak('hi', { voice: 'Bob' });
		expect(spoken[0]!.voice).toEqual({ name: 'Bob' });

		// An unknown voice name leaves the utterance voice unset (default voice).
		speak('hi', { voice: 'Nobody' });
		expect(spoken[1]!.voice).toBeNull();

		cancelSpeech();
		expect(synth.cancel).toHaveBeenCalledTimes(3); // 2 speaks + 1 explicit cancel
	});
});
