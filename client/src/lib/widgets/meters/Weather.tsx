// Weather meter (presentational, props-only). Multi-sensor: the plugin meta declares the weather.* id
// map (binds:'none'); WidgetHost resolves it (useSensorMap) and passes the `sensors` snapshot. Shows a
// condition icon, the temperature, the condition label, today's high/low, and optional detail
// (feels-like / humidity / wind). BARE DOM; styled in Weather.css via --np-* tokens. Server-side poll
// (~15 min) → very low churn. No location configured → "—".
import type { CSSProperties } from 'react';
import type { SensorState } from '../../core/telemetry';
import { weatherInfo } from '../../core/weather';
import './Weather.css';

type Props = {
	sensors?: Record<string, SensorState>;
	showHiLo?: boolean;
	showDetail?: boolean;
	color?: string;
};

const scalar = (s?: SensorState): number | null =>
	s?.value && s.value.kind === 'scalar' ? s.value.value : null;
const textOf = (s?: SensorState): string | null =>
	s?.value && s.value.kind === 'text' ? s.value.value : null;

export default function Weather({
	sensors = {},
	showHiLo = true,
	showDetail = true,
	color
}: Props) {
	const temp = scalar(sensors.temp);
	const code = scalar(sensors.code);
	const isDay = scalar(sensors.is_day);
	const high = scalar(sensors.high);
	const low = scalar(sensors.low);
	const humidity = scalar(sensors.humidity);
	const wind = scalar(sensors.wind);
	const apparent = scalar(sensors.apparent);
	const unit = textOf(sensors.unit) || 'C';

	const info =
		code == null ? { label: '—', icon: '❓' } : weatherInfo(code, isDay == null || isDay >= 1);
	const deg = (n: number | null) => (n == null ? '—' : `${Math.round(n)}°`);
	const windUnit = unit === 'F' ? 'mph' : 'km/h';
	const vars = color ? ({ '--wx-accent': color } as CSSProperties) : undefined;

	return (
		<div className="weather np-weather" style={vars}>
			<div className="wx-main">
				<span className="wx-icon" role="img" aria-label={info.label}>
					{info.icon}
				</span>
				<div className="wx-temp">
					<span className="wx-temp-val" data-part="value">
						{temp == null ? '—' : `${Math.round(temp)}°${unit}`}
					</span>
					<span className="wx-cond">{info.label}</span>
				</div>
			</div>
			{showHiLo && (high != null || low != null) && (
				<div className="wx-hilo" data-part="hilo">
					<span className="wx-hi">↑ {deg(high)}</span>
					<span className="wx-lo">↓ {deg(low)}</span>
				</div>
			)}
			{showDetail && (apparent != null || humidity != null || wind != null) && (
				<div className="wx-detail" data-part="detail">
					{apparent != null && <span>feels {deg(apparent)}</span>}
					{humidity != null && <span>{Math.round(humidity)}% rh</span>}
					{wind != null && (
						<span>
							{Math.round(wind)} {windUnit}
						</span>
					)}
				</div>
			)}
		</div>
	);
}
