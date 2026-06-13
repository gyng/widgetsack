// Top Process meter (presentational, props-only). Shows the single busiest process by the chosen
// metric (CPU % / RAM / disk I/O / GPU VRAM) — "what's eating my machine". Multi-sensor: the meta's
// `sensors` map (config-driven via topProcessSensors) binds proc.<by>.top.{name,value}; WidgetHost
// passes the `sensors` snapshot. The backend only samples a metric while its widget is mounted, so a
// metric nothing shows costs nothing. BARE DOM; styled in TopProcess.css via --np-* tokens.
import type { CSSProperties } from 'react';
import type { SensorState } from '../../core/telemetry';
import { topMetric } from '../../core/topProcess';
import { formatScalar } from '../../core/format';
import './TopProcess.css';

type Props = {
	sensors?: Record<string, SensorState>;
	by?: string;
	label?: string;
	color?: string;
};

const scalar = (s?: SensorState): number | null =>
	s?.value && s.value.kind === 'scalar' ? s.value.value : null;
const textOf = (s?: SensorState): string | null =>
	s?.value && s.value.kind === 'text' ? s.value.value : null;

export default function TopProcess({ sensors = {}, by = 'cpu', label, color }: Props) {
	const m = topMetric(by);
	const name = textOf(sensors.name);
	const value = scalar(sensors.value);
	const vars = color ? ({ '--tp-accent': color } as CSSProperties) : undefined;

	return (
		<div className="topproc np-topproc" style={vars} data-metric={m.id}>
			<span className="tp-icon" role="img" aria-label={m.label}>
				{m.icon}
			</span>
			<div className="tp-body">
				<span className="tp-label">{label || `Top ${m.label}`}</span>
				<span className="tp-name" data-part="value" title={name ?? ''}>
					{name ?? '—'}
				</span>
			</div>
			<span className="tp-value">{value == null ? '—' : formatScalar(value, m.format)}</span>
		</div>
	);
}
