// The LLM chat transcript store — a single growing whole-value (createStore<ChatState>, the mediaStore
// shape), since a chat is one stream every subscriber watches (unlike the per-id telemetry hub). The
// pure reducers live in core/llm.ts; this file only holds the instance + the side-effect-free handlers
// the Tauri `llm_delta` adapter (lib/llm/source.ts) and the chat hook call.
import { applyDelta, emptyChat, type ChatState, type LlmDelta } from '../lib/core/llm';
import { createStore, useStore } from './createStore';

export const llmStore = createStore<ChatState>(emptyChat());

/** Fold one streamed delta into the transcript (called by the `llm_delta` adapter). */
export function handleDelta(delta: LlmDelta): void {
	llmStore.update((s) =>
		s.turns.some((t) => t.id === delta.requestId && t.streaming) ? applyDelta(s, delta) : s
	);
}

/** Clear the transcript. */
export function resetChat(): void {
	llmStore.set(emptyChat());
}

/** Subscribe a React component to the transcript. */
export function useChat(): ChatState {
	return useStore(llmStore);
}
