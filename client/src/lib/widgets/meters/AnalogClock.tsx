// Self-sourcing analog clock meter (an Enigma Clock "Icon"-style ring + ROUNDLINE hands).
// PURE DOM — no SVG, no inline look — so it restyles entirely from CSS like the NowPlaying meter:
// every colour/size is a CSS variable (config overrides) or a class the editable `css` field can
// target. Only the per-tick hand ROTATION is inline (it's data, not style). Ticks: each is wrapped in
// a full-face layer that rotates, so a percentage-positioned mark lands on the dial without trig.
import { type CSSProperties } from 'react';
import { handAngles, updatePeriod } from './analogClockMath';
import { useNow } from '../useNow';
import './AnalogClock.css';

type Props = {
	showSeconds?: boolean;
	showTicks?: boolean;
	showNumbers?: boolean;
	showCap?: boolean; // the centre dot over the hand pivots
	updateMs?: number; // redraw interval (ms); low = smooth second-hand sweep, high = lighter
	color?: string; // hour + minute hands, ticks, ring  → --clock-fg
	accent?: string; // second hand + centre cap          → --clock-accent
	face?: string; // face fill (default transparent)    → --clock-face
};

const rot = (deg: number): CSSProperties => ({ transform: `rotate(${deg}deg)` });

export default function AnalogClock({
	showSeconds = true,
	showTicks = false,
	showNumbers = false,
	showCap = false,
	updateMs = 1000,
	color,
	accent,
	face
}: Props) {
	// The shared wall clock at this widget's redraw period (one timer per period per window).
	const now = new Date(useNow(updatePeriod(updateMs)));

	const a = handAngles(now);
	// Config → CSS custom properties (only when set), so classes fall back to theme tokens otherwise.
	const vars: Record<string, string> = {};
	if (color) vars['--clock-fg'] = color;
	if (accent) vars['--clock-accent'] = accent;
	if (face) vars['--clock-face'] = face;

	return (
		<div className="analog-clock np-analog-clock" style={vars as CSSProperties}>
			<div className="np-clock-face">
				{showTicks &&
					Array.from({ length: 60 }, (_, i) => (
						<div key={`t${i}`} className="np-clock-tickwrap" style={rot(i * 6)}>
							<i className={`np-clock-tick${i % 5 === 0 ? ' major' : ''}`} />
						</div>
					))}
				{showNumbers &&
					Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
						<div key={`n${n}`} className="np-clock-numwrap" style={rot(n * 30)}>
							<span className="np-clock-num" style={rot(-n * 30)}>
								{n}
							</span>
						</div>
					))}
				<div className="np-clock-handwrap" style={rot(a.hour)}>
					<i className="np-clock-hand np-clock-hour" />
				</div>
				<div className="np-clock-handwrap" style={rot(a.minute)}>
					<i className="np-clock-hand np-clock-minute" />
				</div>
				{showSeconds && (
					<div className="np-clock-handwrap" style={rot(a.second)}>
						<i className="np-clock-hand np-clock-second" />
					</div>
				)}
				{showCap && <i className="np-clock-cap" />}
			</div>
		</div>
	);
}
