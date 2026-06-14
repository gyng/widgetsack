import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

// llm_stream rejects (the real-world "AI provider not configured" / backend error case). The hook
// must NOT leave the opened assistant turn streaming forever — it should surface the error.
vi.mock('../widgets/plugins/llm-commands', () => ({
	llmStream: vi.fn(() => Promise.reject('AI provider not configured')),
	llmCancel: vi.fn()
}));
// No Tauri in the test: the delta source is a no-op unlisten.
vi.mock('./source', () => ({ startLlmSource: () => Promise.resolve(() => undefined) }));

import { useLlmChat } from './useLlmChat';
import { resetChat } from '../../stores/llmStore';

beforeEach(() => resetChat());
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
});
