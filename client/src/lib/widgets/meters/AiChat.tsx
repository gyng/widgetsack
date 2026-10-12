import type { ChatTurn } from '../../core/llm';
import './ToolWidget.css';
type Props = {
	label: string;
	turns: ChatTurn[];
	input: string;
	busy: boolean;
	onInput: (value: string) => void;
	onSend: () => void;
	onStop: () => void;
	onClear: () => void;
};
export default function AiChat({
	label,
	turns,
	input,
	busy,
	onInput,
	onSend,
	onStop,
	onClear
}: Props) {
	return (
		<section className="np-tool-widget np-ai-chat" data-part="root">
			<header>
				<strong>{label}</strong>
				<button type="button" disabled={!turns.length} onClick={onClear}>
					Clear
				</button>
			</header>
			<div className="tool-output" role="log" aria-label="Conversation">
				{turns.length === 0 && (
					<p className="tool-hint">
						Ask your AI provider a question. Configure it in Settings → AI Provider. Chat is shared
						within this window.
					</p>
				)}
				{turns.map((turn) => (
					<div className="chat-turn" key={turn.id}>
						<small>{turn.role === 'user' ? 'You' : 'AI'}</small>
						<p>{turn.error || turn.content || '…'}</p>
					</div>
				))}
			</div>
			<form
				aria-label="Ask AI"
				onSubmit={(e) => {
					e.preventDefault();
					onSend();
				}}
			>
				<input
					aria-label="Message"
					placeholder="Ask anything…"
					value={input}
					onChange={(e) => onInput(e.currentTarget.value)}
				/>
				{busy ? (
					<button type="button" onClick={onStop}>
						Stop
					</button>
				) : (
					<button type="submit" disabled={!input.trim()}>
						Send
					</button>
				)}
			</form>
		</section>
	);
}
