import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ChatMessage } from '../../core/llm';
import type { Recorder } from '../../stt';

// Mock every outer-ring dependency the hook touches: the mic recorder (lib/stt), the two LLM Tauri
// command adapters (transcribe + complete), and the TTS adapter. The hook's own branch logic
// (push-to-talk toggle, transcribe→translate→speak flow, the re-entrancy guard, error handling) is
// what we assert. `buildTranslateMessages` is a pure core fn, left REAL so we verify the host calls
// translate with the right shape.
const { startRecording, llmTranscribe, llmComplete, speakSmart, makeRecorder } = vi.hoisted(() => {
	const makeRecorder = (bytes = new Uint8Array([1, 2, 3]), mime = 'audio/webm') => ({
		stop: vi.fn(() => Promise.resolve({ bytes, mime })),
		cancel: vi.fn()
	});
	return {
		makeRecorder,
		startRecording: vi.fn<(deviceId?: string) => Promise<Recorder>>(),
		llmTranscribe: vi.fn<
			(
				audio: Uint8Array,
				mime: string,
				opts?: { model?: string; language?: string }
			) => Promise<string>
		>(() => Promise.resolve('hello world')),
		llmComplete: vi.fn<
			(
				messages: ChatMessage[],
				opts?: { temperature?: number; maxTokens?: number }
			) => Promise<string>
		>(() => Promise.resolve('hola mundo')),
		speakSmart: vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
	};
});
vi.mock('../../stt', () => ({ startRecording }));
vi.mock('../plugins/llm-commands', () => ({ llmTranscribe, llmComplete }));
vi.mock('../plugins/llm-tts', () => ({ speakSmart }));

import { useTranscribe, type TranscribeConfig } from './useTranscribe';

const cfg = (over: Partial<TranscribeConfig> = {}): TranscribeConfig => ({
	mode: 'transcribe',
	targetLang: 'Spanish',
	...over
});

beforeEach(() => {
	startRecording.mockResolvedValue(makeRecorder());
	llmTranscribe.mockResolvedValue('hello world');
	llmComplete.mockResolvedValue('hola mundo');
	speakSmart.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('useTranscribe — push-to-talk recording', () => {
	it('starts the mic on first toggle and flips to recording', async () => {
		const { result } = renderHook(() => useTranscribe(cfg()));
		expect(result.current.recording).toBe(false);

		await act(async () => {
			result.current.toggle();
		});

		expect(startRecording).toHaveBeenCalledOnce();
		expect(result.current.recording).toBe(true);
		expect(result.current.error).toBe('');
	});

	it('passes a blank audioSource through as undefined (system default mic)', async () => {
		const { result } = renderHook(() => useTranscribe(cfg({ audioSource: '' })));
		await act(async () => {
			result.current.toggle();
		});
		expect(startRecording).toHaveBeenCalledWith(undefined);
	});

	it('passes a chosen audioSource through to the recorder', async () => {
		const { result } = renderHook(() => useTranscribe(cfg({ audioSource: 'mic-42' })));
		await act(async () => {
			result.current.toggle();
		});
		expect(startRecording).toHaveBeenCalledWith('mic-42');
	});

	it('surfaces a getUserMedia rejection as an error and stays not-recording', async () => {
		startRecording.mockRejectedValueOnce(new Error('permission denied'));
		const { result } = renderHook(() => useTranscribe(cfg()));

		await act(async () => {
			result.current.toggle();
		});

		expect(result.current.recording).toBe(false);
		expect(result.current.error).toContain('permission denied');
	});

	it('ignores a rapid second toggle while a start is still pending (re-entrancy guard)', async () => {
		let resolveStart!: (r: ReturnType<typeof makeRecorder>) => void;
		startRecording.mockImplementationOnce(
			() => new Promise((res) => (resolveStart = res as typeof resolveStart))
		);
		const { result } = renderHook(() => useTranscribe(cfg()));

		// Two presses before the first startRecording resolves: the second must be dropped.
		act(() => {
			result.current.toggle();
			result.current.toggle();
		});
		await act(async () => {
			resolveStart(makeRecorder());
		});

		expect(startRecording).toHaveBeenCalledOnce();
		expect(result.current.recording).toBe(true);
	});
});

describe('useTranscribe — stop, transcribe, translate, speak', () => {
	it('transcribe mode: stops, transcribes, and shows the trimmed transcript (no translate/speak)', async () => {
		llmTranscribe.mockResolvedValueOnce('  hello world  ');
		const rec = makeRecorder(new Uint8Array([9, 9]), 'audio/ogg');
		startRecording.mockResolvedValueOnce(rec);
		const { result } = renderHook(() => useTranscribe(cfg({ mode: 'transcribe' })));

		await act(async () => {
			result.current.toggle(); // start
		});
		await act(async () => {
			result.current.toggle(); // stop → transcribe
		});

		expect(rec.stop).toHaveBeenCalledOnce();
		expect(llmTranscribe).toHaveBeenCalledWith(new Uint8Array([9, 9]), 'audio/ogg', {
			model: undefined,
			language: undefined
		});
		expect(result.current.source).toBe('hello world');
		expect(result.current.output).toBe('hello world');
		expect(result.current.recording).toBe(false);
		expect(result.current.busy).toBe(false);
		expect(llmComplete).not.toHaveBeenCalled();
		expect(speakSmart).not.toHaveBeenCalled();
	});

	it('forwards the model + sourceLang overrides to the transcription call', async () => {
		const { result } = renderHook(() =>
			useTranscribe(cfg({ model: 'gpt-4o-transcribe', sourceLang: 'de' }))
		);
		await act(async () => {
			result.current.toggle();
		});
		await act(async () => {
			result.current.toggle();
		});
		expect(llmTranscribe).toHaveBeenCalledWith(expect.any(Uint8Array), expect.any(String), {
			model: 'gpt-4o-transcribe',
			language: 'de'
		});
	});

	it('translate mode: transcribes then translates into the target language', async () => {
		llmTranscribe.mockResolvedValueOnce('hello world');
		llmComplete.mockResolvedValueOnce('  hola mundo  ');
		const { result } = renderHook(() =>
			useTranscribe(cfg({ mode: 'translate', targetLang: 'Spanish' }))
		);

		await act(async () => {
			result.current.toggle();
		});
		await act(async () => {
			result.current.toggle();
		});

		expect(result.current.source).toBe('hello world'); // raw transcript kept
		expect(result.current.output).toBe('hola mundo'); // translated + trimmed
		const [messages, opts] = llmComplete.mock.calls[0]!;
		expect(opts).toEqual({ temperature: 0 });
		// buildTranslateMessages (real) → a system translate instruction naming the target + the user text.
		expect(messages[0].role).toBe('system');
		expect(messages[0].content).toContain('Spanish');
		expect(messages[1]).toEqual({ role: 'user', content: 'hello world' });
	});

	it('translate mode with an empty transcript skips the translate call', async () => {
		llmTranscribe.mockResolvedValueOnce('   ');
		const { result } = renderHook(() => useTranscribe(cfg({ mode: 'translate' })));

		await act(async () => {
			result.current.toggle();
		});
		await act(async () => {
			result.current.toggle();
		});

		expect(llmComplete).not.toHaveBeenCalled();
		expect(result.current.source).toBe('');
		expect(result.current.output).toBe('');
	});

	it('speaks the result when speak is enabled', async () => {
		llmTranscribe.mockResolvedValueOnce('hello world');
		const { result } = renderHook(() => useTranscribe(cfg({ speak: true })));

		await act(async () => {
			result.current.toggle();
		});
		await act(async () => {
			result.current.toggle();
		});

		expect(speakSmart).toHaveBeenCalledWith('hello world');
	});

	it('does not speak when the result is empty even with speak enabled', async () => {
		llmTranscribe.mockResolvedValueOnce('');
		const { result } = renderHook(() => useTranscribe(cfg({ speak: true })));

		await act(async () => {
			result.current.toggle();
		});
		await act(async () => {
			result.current.toggle();
		});

		expect(speakSmart).not.toHaveBeenCalled();
	});

	it('a second stop in the same batch is a no-op once the recorder ref is consumed', async () => {
		const rec = makeRecorder();
		startRecording.mockResolvedValueOnce(rec);
		const { result } = renderHook(() => useTranscribe(cfg()));

		await act(async () => {
			result.current.toggle(); // start
		});
		// Two stop presses in one batch: the memoised `run` still sees recording===true on the second
		// call, but the recorder ref was already nulled by the first → the `if (!rec) return` guard.
		await act(async () => {
			result.current.toggle();
			result.current.toggle();
		});

		expect(rec.stop).toHaveBeenCalledOnce(); // only the first stop actually transcribed
		expect(llmTranscribe).toHaveBeenCalledOnce();
		expect(result.current.recording).toBe(false);
	});

	it('surfaces a transcription rejection as an error and clears busy', async () => {
		llmTranscribe.mockRejectedValueOnce(new Error('whisper 401'));
		const { result } = renderHook(() => useTranscribe(cfg()));

		await act(async () => {
			result.current.toggle();
		});
		await act(async () => {
			result.current.toggle();
		});

		expect(result.current.error).toContain('whisper 401');
		expect(result.current.busy).toBe(false);
		expect(result.current.recording).toBe(false);
	});
});

describe('useTranscribe — lifecycle', () => {
	it('cancels the recorder on unmount while recording (releases the mic)', async () => {
		const rec = makeRecorder();
		startRecording.mockResolvedValueOnce(rec);
		const { result, unmount } = renderHook(() => useTranscribe(cfg()));

		await act(async () => {
			result.current.toggle();
		});
		unmount();

		expect(rec.cancel).toHaveBeenCalledOnce();
		expect(rec.stop).not.toHaveBeenCalled();
	});

	it('uses the LATEST config at stop time (cfgRef freshness across a re-render)', async () => {
		llmTranscribe.mockResolvedValueOnce('hello world');
		llmComplete.mockResolvedValueOnce('bonjour le monde');
		const { result, rerender } = renderHook((c: TranscribeConfig) => useTranscribe(c), {
			initialProps: cfg({ mode: 'transcribe', targetLang: 'Spanish' })
		});

		await act(async () => {
			result.current.toggle(); // start under the transcribe config
		});
		// Config changes to translate→French between start and stop.
		rerender(cfg({ mode: 'translate', targetLang: 'French' }));
		await act(async () => {
			result.current.toggle(); // stop → should honor the NEW config
		});

		expect(llmComplete).toHaveBeenCalledOnce();
		expect(llmComplete.mock.calls[0]![0][0].content).toContain('French');
		expect(result.current.output).toBe('bonjour le monde');
	});
});
