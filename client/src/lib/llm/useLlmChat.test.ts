import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

// llm_stream defaults to rejecting (the real-world "AI provider not configured" / backend error
// case). The hook must NOT leave the opened assistant turn streaming forever — it should surface the
// error. Individual tests override llmStream via vi.mocked for the happy path.
vi.mock('../widgets/plugins/llm-commands', () => ({
	llmStream: vi.fn(() => Promise.reject('AI provider not configured')),
	llmCancel: vi.fn()
}));
// No Tauri in the test: the delta source is a no-op unlisten by default; individual tests override
// startLlmSource via vi.mocked to exercise the unmount-before-listen race and the stop-on-unmount path.
vi.mock('./source', () => ({
	startLlmSource: vi.fn(() => Promise.resolve(() => undefined))
}));

import { useLlmChat } from './useLlmChat';
import { resetChat } from '../../stores/llmStore';
import { llmCancel, llmStream } from '../widgets/plugins/llm-commands';
import { startLlmSource } from './source';

beforeEach(() => {
	resetChat();
	// Default: the delta source resolves immediately to a no-op stop fn (mount keeps the ref alive).
	vi.mocked(startLlmSource).mockImplementation(() => Promise.resolve(() => undefined));
});
afterEach(() => vi.clearAllMocks());

describe('useLlmChat', () => {
	it('terminates the streaming turn with the error when llm_stream rejects (no eternal "…")', async () => {
		const { result } = renderHook(() => useLlmChat());

		await act(async () => {
			await result.current.send('hello');
		});

		await waitFor(() => {
			const assistant = result.current.chat.turns.find((t) => t.role === 'assistant');
			expect(assistant).toBeTruthy();
			expect(assistant?.streaming).toBe(false);
			expect(assistant?.error).toContain('AI provider not configured');
		});
	});

	it('opens a user turn + a streaming assistant turn and sends the prior transcript', async () => {
		vi.mocked(llmStream).mockResolvedValueOnce(undefined);
		const { result } = renderHook(() => useLlmChat());

		let requestId = '';
		await act(async () => {
			requestId = await result.current.send('  hi there  ');
		});

		// The user turn carries the trimmed text; the assistant turn (id === requestId) is streaming.
		const turns = result.current.chat.turns;
		expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
		expect(turns[0].content).toBe('hi there');
		expect(turns[1].id).toBe(requestId);
		expect(turns[1].streaming).toBe(true);

		// llm_stream got the request id + the prior transcript (the empty assistant turn filtered out).
		expect(llmStream).toHaveBeenCalledWith(requestId, [{ role: 'user', content: 'hi there' }]);
	});

	it('ignores blank input (no turn opened, no stream started)', async () => {
		const { result } = renderHook(() => useLlmChat());

		let requestId = 'unset';
		await act(async () => {
			requestId = await result.current.send('   ');
		});

		expect(requestId).toBe('');
		expect(result.current.chat.turns).toHaveLength(0);
		expect(llmStream).not.toHaveBeenCalled();
	});

	it('cancel() forwards the request id to llm_cancel', () => {
		const { result } = renderHook(() => useLlmChat());
		act(() => result.current.cancel('chat-7'));
		expect(llmCancel).toHaveBeenCalledWith('chat-7');
	});

	it('reset() clears the transcript', async () => {
		vi.mocked(llmStream).mockResolvedValueOnce(undefined);
		const { result } = renderHook(() => useLlmChat());
		await act(async () => {
			await result.current.send('hello');
		});
		expect(result.current.chat.turns.length).toBeGreaterThan(0);
		act(() => result.current.reset());
		expect(result.current.chat.turns).toHaveLength(0);
	});

	it('stops the delta source if it resolves AFTER unmount (no leaked listener)', async () => {
		const stop = vi.fn();
		let resolve: (fn: () => void) => void = () => undefined;
		// Defer the source promise so unmount happens before startLlmSource resolves.
		vi.mocked(startLlmSource).mockImplementationOnce(
			() => new Promise<() => void>((res) => (resolve = res))
		);
		const { unmount } = renderHook(() => useLlmChat());
		unmount(); // cancelled = true before the source resolves
		await act(async () => {
			resolve(stop); // late resolution: the effect must call stop immediately
			await Promise.resolve();
		});
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it('stops the delta source on a normal unmount', async () => {
		const stop = vi.fn();
		vi.mocked(startLlmSource).mockImplementationOnce(() => Promise.resolve(stop));
		const { unmount } = renderHook(() => useLlmChat());
		// Let the (immediately-resolving) source settle so `stop` is captured.
		await act(async () => {
			await Promise.resolve();
		});
		expect(stop).not.toHaveBeenCalled();
		unmount();
		expect(stop).toHaveBeenCalledTimes(1);
	});
});
