// AI chat wiring lives here; the meter receives only plain data and callbacks.
import { useState } from 'react';
import { useLlmChat } from '../llm/useLlmChat';
import AiChat from './meters/AiChat';
export default function AiChatHost({ label = 'AI Assistant' }: { label?: string }) {
	const { chat, send, cancel, reset } = useLlmChat();
	const [input, setInput] = useState('');
	const active = chat.turns.filter((t) => t.streaming);
	const submit = () => {
		const text = input.trim();
		if (!text || active.length) return;
		setInput('');
		void send(text);
	};
	return (
		<AiChat
			label={label}
			turns={chat.turns}
			input={input}
			busy={active.length > 0}
			onInput={setInput}
			onSend={submit}
			onStop={() => active.forEach((t) => cancel(t.id))}
			onClear={reset}
		/>
	);
}
