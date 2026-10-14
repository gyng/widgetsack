import Icon from '../Icon';
// Timer widget (binds:'none', interactive): a countdown timer or stopwatch with start / pause / reset.
// Self-sourcing — the tick lives in useTimer; the presentation is the pure TimerView below.
import { formatDuration } from '../../core/timer';
import { useTimer, type TimerMode } from './useTimer';
import './Timer.css';
import TimerDial from './TimerDial';

export type TimerViewProps = {
	time: string;
	running?: boolean;
	done?: boolean;
	label?: string;
	color?: string;
	onToggle?: () => void;
	onReset?: () => void;
	disabled?: boolean;
};

/** Pure presentation: the formatted time + the start/pause and reset controls. */
export function TimerView({
	time,
	running = false,
	done = false,
	label = '',
	color,
	onToggle,
	onReset,
	disabled = false
}: TimerViewProps) {
	const colorCss = color || 'var(--np-fg, rgb(255, 255, 255))';
	return (
		<div
			className={`timer np-timer${done ? ' is-done' : ''}`}
			data-part="root"
			style={{ color: colorCss }}
		>
			{label && (
				<span className="timer-label" data-part="label">
					{label}
				</span>
			)}
			<span className="timer-time" data-part="value">
				{time}
			</span>
			{(onToggle || onReset) && (
				<div className="timer-controls" data-part="controls">
					{onToggle && (
						<button
							type="button"
							className="timer-btn"
							disabled={disabled}
							onClick={onToggle}
							title={running ? 'Pause' : 'Start'}
							aria-label={running ? 'Pause' : 'Start'}
						>
							<Icon name={running ? 'pause' : 'play'} />
						</button>
					)}
					{onReset && (
						<button
							type="button"
							className="timer-btn"
							disabled={disabled}
							onClick={onReset}
							title="Reset"
							aria-label="Reset"
						>
							↺
						</button>
					)}
				</div>
			)}
		</div>
	);
}

type Props = {
	style?: string;
	editMode?: boolean;
	previewMode?: boolean;
	widgetId?: string;
	mode?: TimerMode;
	duration?: number;
	format?: string;
	loop?: boolean;
	label?: string;
	color?: string;
};

export default function Timer({
	widgetId,
	mode = 'countdown',
	duration = 300,
	format = 'auto',
	loop = false,
	label = '',
	color,
	style = 'digital',
	editMode = false,
	previewMode = false
}: Props) {
	const { seconds, running, done, toggle, reset, setCountdown } = useTimer({
		mode,
		duration:
			style === 'dial' && mode === 'countdown' ? Math.max(0, Math.min(3600, duration)) : duration,
		loop,
		storageKey: widgetId ? `widgetsack.timer.${widgetId}` : undefined,
		readOnly: editMode || previewMode
	});
	// A countdown shows the CEILING (4.2s left reads "00:05"); a stopwatch floors.
	const shown = mode === 'countdown' ? Math.ceil(seconds) : seconds;
	if (style === 'dial' && mode === 'countdown')
		return (
			<TimerDial
				seconds={seconds}
				running={running}
				done={done}
				label={label}
				color={color}
				disabled={editMode || previewMode}
				onSet={setCountdown}
				onToggle={toggle}
			/>
		);
	return (
		<TimerView
			time={formatDuration(shown, format)}
			running={running}
			done={done}
			label={label}
			color={color}
			disabled={editMode || previewMode}
			onToggle={toggle}
			onReset={reset}
		/>
	);
}
