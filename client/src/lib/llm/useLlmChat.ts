// React subscription to the shared window-local chat session.
import { useEffect } from 'react';
import type { ChatState } from '../core/llm';
import { useChat } from '../../stores/llmStore';
import { acquireChatSession, cancelChatRequest, resetChatSession, sendChat } from './chatSession';

export type LlmChat = {
	chat: ChatState;
	send: (text: string) => Promise<string>;
	cancel: (requestId: string) => void;
	reset: () => void;
};
export function useLlmChat(): LlmChat {
	const chat = useChat();
	useEffect(acquireChatSession, []);
	return { chat, send: sendChat, cancel: cancelChatRequest, reset: resetChatSession };
}
