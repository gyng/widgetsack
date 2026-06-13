// Air Quality meter (presentational, props-only). Multi-sensor: the weather-plugin meta binds
// weather.air.aqi + weather.air.pm25 + weather.uv via a sensors map; WidgetHost passes the snapshot.
// Shows the European AQI with a colour-coded band, plus optional PM2.5 + UV index. BARE DOM; styled in
// AirQuality.css via --np-* / --aq-* tokens.
import type { CSSProperties } from 'react';
import type { SensorState } from '../../core/telemetry';
import { aqiBand, uvBand } from '../../core/airQuality';
import './AirQuality.css';

type Props = {
	sensors?: Record<string, SensorState>;
	showPm?: boolean;
	showUv?: boolean;
	color?: string;
};

const scalar = (s?: SensorState): number | null =>
	s?.value && s.value.kind === 'scalar' ? s.value.value : null;

export default function AirQuality({ sensors = {}, showPm = true, showUv = true, color }: Props) {
	const aqi = scalar(sensors.aqi);
	const pm25 = scalar(sensors.pm25);
	const uv = scalar(sensors.uv);
	const band = aqiBand(aqi);
	const uvb = uvBand(uv);
	const vars = color ? ({ '--aq-accent': color } as CSSProperties) : undefined;

	return (
		<div className="airquality np-airquality" style={vars} data-level={band.level}>
			<div className="aq-head">
				<span className="aq-title">Air quality</span>
			</div>
			<div className="aq-main">
				<span className="aq-value" data-part="value">
					{aqi == null ? '—' : Math.round(aqi)}
				</span>
				<span className="aq-band">{band.label}</span>
			</div>
			{(showPm || showUv) && (aqi != null || uv != null) && (
				<div className="aq-detail" data-part="detail">
					{showPm && pm25 != null && <span>PM2.5 {pm25.toFixed(1)} µg/m³</span>}
					{showUv && uv != null && (
						<span data-uv={uvb.level}>
							UV {Math.round(uv)} · {uvb.label}
						</span>
					)}
				</div>
			)}
		</div>
	);
}
