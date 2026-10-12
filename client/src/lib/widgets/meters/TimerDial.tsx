import { useId, useRef, useState, type PointerEvent, type CSSProperties } from 'react';
import { dialMinutes } from '../../core/timerDial';
import { formatDuration } from '../../core/timer';
import './TimerDial.css';

export default function TimerDial({
	seconds,
	running,
	done,
	label,
	color,
	disabled,
	onSet,
	onToggle
}: {
	seconds: number;
	running: boolean;
	done: boolean;
	label: string;
	color?: string;
	disabled: boolean;
	onSet: (seconds: number) => void;
	onToggle: () => void;
}) {
	const id = useId();
	const drag = useRef<{ id: number; minutes: number } | null>(null);
	const [preview, setPreview] = useState<number | null>(null);
	const minutes = preview ?? Math.min(60, seconds / 60);
	const angle = minutes * 5 - 150;
	const point = (event: PointerEvent<HTMLDivElement>, previous?: number) => {
		const rect = event.currentTarget.getBoundingClientRect();
		const x = event.clientX - rect.x - rect.width / 2;
		const y = event.clientY - rect.y - rect.height / 2;
		if (Math.hypot(x, y) < Math.min(rect.width, rect.height) * 0.15)
			return previous ?? Math.round(minutes);
		return dialMinutes(x, y, previous);
	};
	const cancel = () => {
		drag.current = null;
		setPreview(null);
	};
	return (
		<div
			className="timer np-timer timer-dial"
			style={color ? ({ '--dial-accent': color } as CSSProperties) : undefined}
		>
			{label && <span className="timer-label">{label}</span>}
			<div
				className="dial-face"
				role="slider"
				aria-label="Timer duration"
				aria-valuemin={0}
				aria-valuemax={60}
				aria-valuenow={Math.round(minutes)}
				aria-valuetext={`${formatDuration(Math.ceil(minutes * 60), 'mm:ss')} remaining`}
				aria-disabled={disabled}
				tabIndex={disabled ? -1 : 0}
				onPointerDown={(event) => {
					if (disabled || event.button !== 0 || drag.current) return;
					event.preventDefault();
					event.stopPropagation();
					const value = (event.target as Element).closest('[data-knob]')
						? Math.round(minutes)
						: point(event);
					drag.current = { id: event.pointerId, minutes: value };
					setPreview(value);
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={(event) => {
					if (!drag.current || drag.current.id !== event.pointerId) return;
					const value = point(event, drag.current.minutes);
					drag.current.minutes = value;
					setPreview(value);
				}}
				onPointerUp={(event) => {
					if (disabled) {
						cancel();
						return;
					}
					if (!drag.current || drag.current.id !== event.pointerId) return;
					const value = drag.current.minutes;
					cancel();
					event.currentTarget.releasePointerCapture(event.pointerId);
					onSet(value * 60);
				}}
				onPointerCancel={cancel}
				onLostPointerCapture={cancel}
				onKeyDown={(event) => {
					if (disabled) return;
					const steps: Record<string, number> = {
						ArrowUp: 1,
						ArrowRight: 1,
						ArrowDown: -1,
						ArrowLeft: -1,
						PageUp: 5,
						PageDown: -5
					};
					let value: number;
					if (event.key === 'Home') value = 0;
					else if (event.key === 'End') value = 60;
					else if (steps[event.key] !== undefined)
						value = Math.max(0, Math.min(60, Math.round(minutes) + steps[event.key]));
					else return;
					event.preventDefault();
					onSet(value * 60);
				}}
			>
				<svg viewBox="0 0 200 200" aria-hidden="true">
					<defs>
						<radialGradient id={`${id}-face`}>
							<stop stopColor="#f6f3eb" />
							<stop offset="1" stopColor="#c8c4bb" />
						</radialGradient>
						<linearGradient id={`${id}-knob`} x2="1" y2="1">
							<stop stopColor="#fffdf7" />
							<stop offset="0.5" stopColor="#e2ded5" />
							<stop offset="1" stopColor="#aaa79f" />
						</linearGradient>
					</defs>
					<circle cx="100" cy="100" r="97" className="dial-rim" />
					<circle cx="100" cy="100" r="91" fill={`url(#${id}-face)`} />
					{Array.from({ length: 61 }, (_, i) => (
						<g key={i} transform={`rotate(${i * 5 - 150} 100 100)`}>
							<line x1="100" y1="15" x2="100" y2={i % 5 === 0 ? 24 : 19} className="dial-tick" />
						</g>
					))}
					{Array.from({ length: 13 }, (_, i) => {
						const radians = ((i * 25 - 150) * Math.PI) / 180;
						return (
							<text
								key={i}
								x={100 + Math.sin(radians) * 70}
								y={100 - Math.cos(radians) * 70}
								className="dial-mark"
							>
								{i * 5}
							</text>
						);
					})}
					<circle cx="101" cy="104" r="49" className="dial-shadow" />
					<g data-knob transform={`rotate(${angle} 100 100)`}>
						<circle cx="100" cy="100" r="47" fill={`url(#${id}-knob)`} className="dial-knob" />
						<path d="M100 55 L95 67 L105 67 Z" className="dial-pointer" />
						<rect x="93" y="76" width="14" height="50" rx="7" className="dial-grip" />
					</g>
				</svg>
			</div>
			<span className="timer-time" data-part="value">
				{formatDuration(Math.ceil(minutes * 60), 'mm:ss')}
			</span>
			<span className="dial-hint">
				{preview !== null
					? 'Release to start'
					: done
						? 'Time’s up'
						: running
							? 'Counting down'
							: 'Drag to set · 60 min max'}
			</span>
			<div className="timer-controls">
				<button
					className="timer-btn"
					aria-label={running ? 'Pause' : 'Start'}
					disabled={disabled || seconds === 0}
					onClick={onToggle}
				>
					{running ? 'Pause' : 'Start'}
				</button>
				<button
					className="timer-btn"
					aria-label="Reset"
					disabled={disabled}
					onClick={() => onSet(0)}
				>
					Reset
				</button>
			</div>
		</div>
	);
}
