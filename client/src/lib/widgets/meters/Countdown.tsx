// Self-sourcing Countdown meter (binds:'none'): counts down to a TARGET DATE (a "days until X" view)
// or runs an auto-cycling Pomodoro rhythm — both driven by the wall clock on a 1s tick, like Clock.
// Distinct from the manual Timer widget (which has start/pause controls). The time math is pure
// (core/countdown.ts); this just ticks and renders. BARE DOM, styled via --np-* / --cd-* tokens.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
	formatCountdown,
	parseTarget,
	pomodoroAt,
	type CountdownFormat
} from '../../core/countdown';
import './Countdown.css';

type Props = {
	mode?: string; // 'event' | 'pomodoro'
	target?: string; // event mode: a datetime string (Date-parseable)
	format?: string; // event display format
	countUp?: boolean; // event mode: after the target passes, count elapsed instead of stopping at 0
	workMin?: number; // pomodoro work minutes
	breakMin?: number; // pomodoro break minutes
	label?: string;
	color?: string;
};

export default function Countdown({
	mode = 'event',
	target = '',
	format = 'auto',
	countUp = false,
	workMin = 25,
	breakMin = 5,
	label,
	color
}: Props) {
	const [now, setNow] = useState(() => Date.now());
	// Pomodoro anchor: when this widget mounted. The rhythm runs from here (resets on reload — fine for
	// a "where am I in the cycle" display; the manual Timer covers precise start/pause).
	const startRef = useRef(now);

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);

	const vars = color ? ({ '--cd-accent': color } as CSSProperties) : undefined;

	let value: string;
	let sub: string | null = null;
	let phase: string;

	if (mode === 'pomodoro') {
		const p = pomodoroAt(now - startRef.current, workMin * 60_000, breakMin * 60_000);
		value = formatCountdown(p.remainingMs, 'ms');
		phase = p.phase; // 'work' | 'break'
		sub = `${p.phase === 'work' ? 'Work' : 'Break'} · #${p.cycle}`;
	} else {
		const targetMs = parseTarget(target);
		if (targetMs == null) {
			value = '—';
			phase = 'idle';
			sub = 'set a target date';
		} else {
			const remaining = targetMs - now;
			if (remaining > 0) {
				value = formatCountdown(remaining, format as CountdownFormat);
				phase = 'counting';
			} else if (countUp) {
				value = `+${formatCountdown(-remaining, format as CountdownFormat)}`;
				phase = 'elapsed';
			} else {
				value = formatCountdown(0, format as CountdownFormat);
				phase = 'reached';
			}
		}
	}

	return (
		<div className="countdown np-countdown" style={vars} data-mode={mode} data-phase={phase}>
			{label && (
				<span className="cd-label" data-part="label">
					{label}
				</span>
			)}
			<span className="cd-value" data-part="value">
				{value}
			</span>
			{sub && (
				<span className="cd-sub" data-part="sub">
					{sub}
				</span>
			)}
		</div>
	);
}
