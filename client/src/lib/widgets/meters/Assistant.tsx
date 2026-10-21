import Icon from '../Icon';
// The AI Briefing meter — pure presentation (AGENTS.md §6): renders the generated text / busy /
// error state it is GIVEN. The generation wiring (sensor-hub snapshot, LLM call, interval/cron
// schedule, TTS) lives in the AssistantHost container (../AssistantHost.tsx + ../useAssistant.ts).
import './Assistant.css';

export type AssistantViewProps = {
	text?: string;
	busy?: boolean;
	error?: string;
	label?: string;
	color?: string;
	onRefresh?: () => void;
};

export default function Assistant({
	text = '',
	busy = false,
	error = '',
	label = '',
	color,
	onRefresh
}: AssistantViewProps) {
	// `||` (not `??`) so a blank config color falls back to the theme variable.
	const colorCss = color || 'var(--np-fg, rgb(255, 255, 255))';
	const body = error ? error : text || (busy ? 'Thinking…' : 'No response yet. Generate now.');

	return (
		<div className="assistant np-assistant" data-part="root" style={{ color: colorCss }}>
			{label && (
				<span className="assistant-label" data-part="label">
					{label}
				</span>
			)}
			<span className="assistant-text" data-part="value">
				{error && <Icon name="alert" />} {body}
			</span>
			{onRefresh && (
				<button
					type="button"
					className="assistant-refresh"
					data-part="refresh"
					onClick={onRefresh}
					title="Generate now"
					aria-label="Generate now"
				>
					<Icon name="refresh" />
				</button>
			)}
		</div>
	);
}
