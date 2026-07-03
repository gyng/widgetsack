// Process Watcher meter (presentational, props-only). Multi-sensor: the meta's `sensors` map binds
// proc.watch.<name>.{running,cpu,mem,count} from config.name; WidgetHost passes the snapshot (and the
// subscription tells the backend which process to watch). Shows a running dot + the process name, and
// when running its CPU% + RAM. BARE DOM; styled in ProcessWatch.css via --np-* / --pw-* tokens.
import type { CSSProperties } from 'react';
import type { SensorState } from '../../core/telemetry';
import { formatBytes } from '../../core/format';
import './ProcessWatch.css';

type Props = {
	sensors?: Record<string, SensorState>;
	name?: string;
	label?: string;
	color?: string;
};

const scalar = (s?: SensorState): number | null =>
	s?.value && s.value.kind === 'scalar' ? s.value.value : null;

export default function ProcessWatch({ sensors = {}, name = 'chrome.exe', label, color }: Props) {
	const running = scalar(sensors.running);
	const cpu = scalar(sensors.cpu);
	const mem = scalar(sensors.mem);
	const count = scalar(sensors.count);
	// null before the first sample → "unknown"; 0 → not running; >0 → running.
	const state = running == null ? 'unknown' : running > 0 ? 'running' : 'stopped';
	const vars = color ? ({ '--pw-accent': color } as CSSProperties) : undefined;

	return (
		<div className="procwatch np-procwatch" style={vars} data-state={state}>
			<span className="pw-dot" aria-hidden="true" />
			<div className="pw-body">
				<span className="pw-name" title={name}>
					{label || name}
				</span>
				<span className="pw-status" data-part="value">
					{state === 'unknown'
						? '—'
						: state === 'stopped'
							? 'not running'
							: [
									cpu != null ? `${cpu.toFixed(1)}%` : null,
									mem != null ? formatBytes(mem, 0) : null,
									count != null && count > 1 ? `×${count}` : null
								]
									.filter(Boolean)
									.join(' · ') || 'running'}
				</span>
			</div>
		</div>
	);
}
