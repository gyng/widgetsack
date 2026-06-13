// GPU panel (presentational, props-only). Multi-sensor: the meta declares the gpu.* id map
// (binds:'none'); WidgetHost resolves it (useSensorMap) and passes the `sensors` snapshot. Shows the
// card name, a prominent utilisation %, and whatever secondary metrics NVML reports (temp / VRAM /
// power / clock / fan — missing ones drop out via core/gpu.ts). No samples without NVIDIA/NVML → "—".
import type { CSSProperties } from 'react';
import type { SensorState } from '../../core/telemetry';
import { gpuStats } from '../../core/gpu';
import './GpuPanel.css';

type Props = {
	sensors?: Record<string, SensorState>;
	showName?: boolean;
	label?: string;
	color?: string;
};

const scalar = (s?: SensorState): number | null =>
	s?.value && s.value.kind === 'scalar' ? s.value.value : null;
const textOf = (s?: SensorState): string | null =>
	s?.value && s.value.kind === 'text' ? s.value.value : null;

export default function GpuPanel({ sensors = {}, showName = true, label, color }: Props) {
	const util = scalar(sensors.util);
	const name = label || textOf(sensors.name) || 'GPU';
	const stats = gpuStats({
		temp: scalar(sensors.temp),
		vramUsed: scalar(sensors.vramUsed),
		vramTotal: scalar(sensors.vramTotal),
		power: scalar(sensors.power),
		clockCore: scalar(sensors.clock),
		fan: scalar(sensors.fan)
	});
	const pct = util == null ? 0 : Math.max(0, Math.min(100, util));
	const vars = {
		'--gpu-pct': `${pct}%`,
		...(color ? { '--gpu-accent': color } : {})
	} as CSSProperties;

	return (
		<div className="gpu-panel np-gpu" style={vars}>
			{showName && (
				<div className="gpu-name" data-part="name" title={name}>
					{name}
				</div>
			)}
			<div className="gpu-util">
				<span className="gpu-util-val" data-part="value">
					{util == null ? '—' : `${Math.round(pct)}%`}
				</span>
				<div className="gpu-util-bar">
					<span className="gpu-util-fill" />
				</div>
			</div>
			{stats.length > 0 && (
				<div className="gpu-stats">
					{stats.map((s) => (
						<div key={s.key} className="gpu-stat">
							<span className="gpu-stat-label">{s.label}</span>
							<span className="gpu-stat-val">{s.value}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
