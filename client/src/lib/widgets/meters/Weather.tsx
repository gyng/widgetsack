// Weather meter (presentational, props-only). Multi-sensor: the plugin meta declares the weather.* id
// map (binds:'none'); WidgetHost resolves it (useSensorMap) and passes the `sensors` snapshot. Shows a
// condition icon, the temperature, the condition label, today's high/low, and optional detail
// (feels-like / humidity / wind). BARE DOM; styled in Weather.css via --np-* tokens. Server-side poll
// (~15 min) → very low churn. No location configured → "—".
import { useState, type CSSProperties } from 'react';
import type { SensorState } from '../../core/telemetry';
import { weatherInfo, labelForecast, type ForecastCell } from '../../core/weather';
import './Weather.css';

type Props = {
	sensors?: Record<string, SensorState>;
	showHiLo?: boolean;
	showDetail?: boolean;
	forecastDays?: number;
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
	forecastDays = 0,
	color
}: Props) {
	// Snapshot the clock once at mount for the forecast day labels (Today / weekday). Reading it during
	// render would be impure, and the labels only need day granularity, so a mount snapshot suffices.
	const [now] = useState(() => Date.now());
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

	// Multi-day forecast strip (off when forecastDays is 0). Cells are read from the day.N.* sensors the
	// meta subscribes; only days that actually have data are shown (a short backend array → fewer cols).
	const days = Math.max(0, Math.min(7, Math.floor(forecastDays)));
	const cells: ForecastCell[] = [];
	for (let i = 0; i < days; i++) {
		cells.push({
			code: scalar(sensors[`d${i}code`]),
			high: scalar(sensors[`d${i}high`]),
			low: scalar(sensors[`d${i}low`])
		});
	}
	const forecast = labelForecast(cells, now).filter(
		(d) => d.high != null || d.low != null || d.code != null
	);

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
			{forecast.length > 0 && (
				<div className="wx-forecast" data-part="forecast">
					{forecast.map((d, i) => (
						<div className="wx-day" key={i}>
							<span className="wx-day-label">{d.label}</span>
							<span className="wx-day-icon" role="img" aria-label={d.info.label}>
								{d.info.icon}
							</span>
							<span className="wx-day-hilo">
								<span className="wx-day-hi">{deg(d.high)}</span>
								<span className="wx-day-lo">{deg(d.low)}</span>
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
