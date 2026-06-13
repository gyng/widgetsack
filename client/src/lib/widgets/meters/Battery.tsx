// Battery indicator (presentational, props-only). Multi-sensor: the meta declares the battery.* id
// map (binds:'none'), WidgetHost resolves it via useSensorMap and passes the `sensors` snapshot.
// Renders a fill icon + percent + charging/time-left status. BARE DOM; styled in Battery.css via
// --np-* tokens with --bat-* overrides. No samples on a desktop (no battery) → shows "—".
import type { CSSProperties } from 'react';
import type { SensorState } from '../../core/telemetry';
import { batteryStatusText, batteryLevel } from '../../core/battery';
import './Battery.css';

type Props = {
	sensors?: Record<string, SensorState>;
	showStatus?: boolean;
	color?: string;
};

const scalar = (s?: SensorState): number | null =>
	s?.value && s.value.kind === 'scalar' ? s.value.value : null;
const textOf = (s?: SensorState): string | null =>
	s?.value && s.value.kind === 'text' ? s.value.value : null;

export default function Battery({ sensors = {}, showStatus = true, color }: Props) {
	const percent = scalar(sensors.percent);
	const state = textOf(sensors.state);
	const time = scalar(sensors.time);
	const charging = state === 'charging';
	const level = batteryLevel(percent, charging);
	const status = batteryStatusText(state, time);
	const pct = percent == null ? 0 : Math.max(0, Math.min(100, percent));

	const vars = {
		'--bat-pct': `${pct}%`,
		...(color ? { '--bat-accent': color } : {})
	} as CSSProperties;

	return (
		<div
			className="battery np-battery"
			style={vars}
			data-level={level}
			data-charging={charging || undefined}
		>
			<div
				className="bat-icon"
				role="img"
				aria-label={`Battery ${percent == null ? 'unknown' : `${Math.round(pct)}%`}${
					charging ? ', charging' : ''
				}`}
			>
				<span className="bat-fill" />
				{charging && <span className="bat-bolt">⚡</span>}
			</div>
			<div className="bat-text">
				<span className="bat-pct" data-part="value">
					{percent == null ? '—' : `${Math.round(pct)}%`}
				</span>
				{showStatus && status && (
					<span className="bat-status" data-part="status">
						{status}
					</span>
				)}
			</div>
		</div>
	);
}
