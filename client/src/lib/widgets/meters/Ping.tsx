// Ping meter (presentational, props-only): "is <host> reachable, and how fast?". Multi-sensor — the
// meta's `sensors` map binds net.ping.<host>.{ms,up} from config.host, WidgetHost subscribes and passes
// the snapshot. Subscribing is also what tells the backend poller which host to ping (demand gate), so
// nothing is pinged unless this widget is mounted. A status dot + latency; BARE DOM, styled via --np-*.
import type { CSSProperties } from 'react';
import type { SensorState } from '../../core/telemetry';
import { pingLevel } from '../../core/ping';
import './Ping.css';

type Props = {
	sensors?: Record<string, SensorState>;
	host?: string;
	label?: string;
	slowMs?: number;
	color?: string;
};

const scalar = (s?: SensorState): number | null =>
	s?.value && s.value.kind === 'scalar' ? s.value.value : null;

export default function Ping({
	sensors = {},
	host = '1.1.1.1',
	label,
	slowMs = 150,
	color
}: Props) {
	const up = scalar(sensors.up);
	const ms = scalar(sensors.ms);
	const level = pingLevel(up, ms, slowMs);
	const vars = color ? ({ '--ping-accent': color } as CSSProperties) : undefined;

	const value =
		level === 'unknown'
			? '—'
			: level === 'down'
			? 'down'
			: ms == null
			? 'up'
			: `${Math.round(ms)} ms`;

	return (
		<div className="ping np-ping" style={vars} data-level={level}>
			<span className="ping-dot" aria-hidden="true" />
			<span className="ping-host" title={host}>
				{label || host}
			</span>
			<span className="ping-value" data-part="value">
				{value}
			</span>
		</div>
	);
}
