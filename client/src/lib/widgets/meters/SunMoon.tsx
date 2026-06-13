// Sun & Moon meter. Sunrise/sunset come from the weather source (the meta binds weather.sun.{rise,set}
// via a sensors map — props-only), while the moon phase is computed from the wall clock here on a slow
// tick (it needs no backend). So it's a hybrid like Calendar: props for the sun, a self-tick for the
// moon. BARE DOM; styled in SunMoon.css via --np-* tokens.
import { useEffect, useState, type CSSProperties } from 'react';
import type { SensorState } from '../../core/telemetry';
import { moonInfo, moonPhase, sunTime } from '../../core/moon';
import './SunMoon.css';

type Props = {
	sensors?: Record<string, SensorState>;
	showSun?: boolean;
	showMoon?: boolean;
	color?: string;
};

const textOf = (s?: SensorState): string | null =>
	s?.value && s.value.kind === 'text' ? s.value.value : null;

export default function SunMoon({ sensors = {}, showSun = true, showMoon = true, color }: Props) {
	const [now, setNow] = useState(() => Date.now());
	// The moon phase moves slowly — a minute tick keeps it current without churn.
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 60_000);
		return () => clearInterval(t);
	}, []);

	const rise = sunTime(textOf(sensors.rise));
	const set = sunTime(textOf(sensors.set));
	const moon = moonInfo(moonPhase(now));
	const vars = color ? ({ '--sm-accent': color } as CSSProperties) : undefined;

	return (
		<div className="sunmoon np-sunmoon" style={vars}>
			{showSun && (
				<div className="sm-sun" data-part="sun">
					<span className="sm-row">
						<span className="sm-ico" role="img" aria-label="sunrise">
							🌅
						</span>
						<span className="sm-time">{rise ?? '—'}</span>
					</span>
					<span className="sm-row">
						<span className="sm-ico" role="img" aria-label="sunset">
							🌇
						</span>
						<span className="sm-time">{set ?? '—'}</span>
					</span>
				</div>
			)}
			{showMoon && (
				<div className="sm-moon" data-part="moon">
					<span className="sm-moon-ico" role="img" aria-label={moon.name}>
						{moon.icon}
					</span>
					<span className="sm-moon-body">
						<span className="sm-moon-name">{moon.name}</span>
						<span className="sm-moon-illum">{Math.round(moon.illumination * 100)}% lit</span>
					</span>
				</div>
			)}
		</div>
	);
}
