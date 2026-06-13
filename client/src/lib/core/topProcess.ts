// Pure metric table + sensor-id map for the Top Process widget. No React/DOM — unit-tested. The
// backend emits `proc.<metric>.top.{name,<value-suffix>}` (cpu → pct, the rest → bytes); the meta uses
// `topProcessSensors` to bind them and the meter uses `topMetric` for the icon / label / number format.

export type TopMetric = 'cpu' | 'mem' | 'disk' | 'gpu';

export type TopMetricInfo = {
	id: TopMetric;
	label: string;
	icon: string;
	/** formatScalar format name for the value (% / bytes / per-second rate). */
	format: string;
	/** the `proc.<id>.top.<suffix>` value-sensor suffix. */
	suffix: string;
};

export const TOP_METRICS: TopMetricInfo[] = [
	{ id: 'cpu', label: 'CPU', icon: '🔥', format: 'percent', suffix: 'pct' },
	{ id: 'mem', label: 'RAM', icon: '🧠', format: 'bytes', suffix: 'bytes' },
	{ id: 'disk', label: 'Disk', icon: '💾', format: 'rate', suffix: 'bytes' },
	{ id: 'gpu', label: 'GPU', icon: '🎮', format: 'bytes', suffix: 'bytes' }
];

/** The chosen metric (defaults to CPU for an unknown value). */
export function topMetric(by: string): TopMetricInfo {
	return TOP_METRICS.find((m) => m.id === by) ?? TOP_METRICS[0];
}

/** The `{ name, value }` sensor-id map for the chosen metric — what WidgetHost subscribes to. */
export function topProcessSensors(by: string): { name: string; value: string } {
	const m = topMetric(by);
	return { name: `proc.${m.id}.top.name`, value: `proc.${m.id}.top.${m.suffix}` };
}
