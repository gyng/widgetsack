import Icon from '../Icon';
// Transcribe / Translate widget (binds:'none', interactive): push-to-talk speech-to-text, optionally
// translated and/or spoken, via the AI provider. Self-sourcing meter — the stateful capture lives in
// useTranscribe; the presentation is the pure TranscribeView below, so it stays trivially testable.
import { useTranscribe } from './useTranscribe';
import './Transcribe.css';

export type TranscribeViewProps = {
	output?: string;
	source?: string;
	mode?: 'transcribe' | 'translate';
	busy?: boolean;
	error?: string;
	recording?: boolean;
	label?: string;
	color?: string;
	onToggle?: () => void;
};

/** Pure presentation: the transcript/translation plus the mic toggle. */
export function TranscribeView({
	output = '',
	source = '',
	mode = 'transcribe',
	busy = false,
	error = '',
	recording = false,
	label = '',
	color,
	onToggle
}: TranscribeViewProps) {
	const colorCss = color || 'var(--np-fg, rgb(255, 255, 255))';
	const placeholder = recording ? 'Listening…' : busy ? 'Transcribing…' : 'Click the mic and speak';
	const body = error ? error : output || placeholder;

	return (
		<div className="transcribe np-transcribe" data-part="root" style={{ color: colorCss }}>
			<div className="transcribe-head">
				{label && (
					<span className="transcribe-label" data-part="label">
						{label}
					</span>
				)}
				{onToggle && (
					<button
						type="button"
						className={`transcribe-mic${recording ? ' is-recording' : ''}`}
						data-part="mic"
						onClick={onToggle}
						title={recording ? 'Stop and transcribe' : 'Record'}
						aria-label={recording ? 'Stop and transcribe' : 'Record'}
					>
						<Icon name={recording ? 'stop' : 'mic'} />
					</button>
				)}
			</div>
			<span className="transcribe-text" data-part="value">
				{error && <Icon name="alert" />} {body}
			</span>
			{/* In translate mode, show the original transcript faintly beneath the translation. */}
			{mode === 'translate' && source && !error && (
				<span className="transcribe-source" data-part="source">
					{source}
				</span>
			)}
		</div>
	);
}

type Props = {
	mode?: 'transcribe' | 'translate';
	targetLang?: string;
	sourceLang?: string;
	model?: string;
	audioSource?: string;
	speak?: boolean;
	label?: string;
	color?: string;
};

export default function Transcribe({
	mode = 'transcribe',
	targetLang = 'English',
	sourceLang = 'auto',
	model = '',
	audioSource = '',
	speak = false,
	label = '',
	color
}: Props) {
	const { source, output, busy, error, recording, toggle } = useTranscribe({
		mode,
		targetLang,
		sourceLang,
		model,
		audioSource,
		speak
	});
	return (
		<TranscribeView
			output={output}
			source={source}
			mode={mode}
			busy={busy}
			error={error}
			recording={recording}
			label={label}
			color={color}
			onToggle={toggle}
		/>
	);
}
