import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useLlmChat } from './useLlmChat';
import { resetChat, handleDelta } from '../../stores/llmStore';
import { llmStream, llmCancel } from '../widgets/plugins/llm-commands';
import { startLlmSource } from './source';
vi.mock('../widgets/plugins/llm-commands', () => ({
	llmStream: vi.fn(async () => undefined),
	llmCancel: vi.fn(async () => undefined)
}));
vi.mock('./source', () => ({ startLlmSource: vi.fn(async () => () => undefined) }));
beforeEach(() => {
	resetChat();
	vi.clearAllMocks();
});
it('keeps shared streams alive until the final consumer leaves', async () => {
	const first = renderHook(useLlmChat);
	const second = renderHook(useLlmChat);
	let id = '';
	await act(async () => {
		id = await first.result.current.send('hello');
	});
	first.unmount();
	expect(llmCancel).not.toHaveBeenCalled();
	act(() => handleDelta({ requestId: id, token: 'hi', done: false }));
	expect(second.result.current.chat.turns.at(-1)?.content).toBe('hi');
	second.unmount();
	expect(llmCancel).toHaveBeenCalledWith(id);
	expect(startLlmSource).toHaveBeenCalledOnce();
});
it('reports a listener failure without starting a backend stream', async () => {
	vi.mocked(startLlmSource).mockRejectedValueOnce(new Error('bridge failed'));
	const { result } = renderHook(useLlmChat);
	await act(async () => {
		await result.current.send('hello');
	});
	expect(llmStream).not.toHaveBeenCalled();
	expect(result.current.chat.turns.at(-1)).toMatchObject({
		streaming: false,
		error: 'Error: bridge failed'
	});
});
it('never starts a send cancelled while waiting for the listener', async () => {
	let ready!: (release: () => void) => void;
	vi.mocked(startLlmSource).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				ready = resolve;
			})
	);
	const release = vi.fn();
	const { result, unmount } = renderHook(useLlmChat);
	let pending!: Promise<string>;
	act(() => {
		pending = result.current.send('hello');
	});
	unmount();
	await act(async () => {
		ready(release);
		await pending;
	});
	expect(llmStream).not.toHaveBeenCalled();
	expect(release).toHaveBeenCalledOnce();
});
