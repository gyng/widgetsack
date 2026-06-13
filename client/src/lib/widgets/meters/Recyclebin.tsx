// Recycle Bin meter (presentational, props-only). Multi-sensor: the meta binds
// recyclebin.{items,bytes} via a sensors map; WidgetHost passes the snapshot. Shows the item count +
// total size, with a "full" cue past an optional threshold. BARE DOM; styled via --np-* / --rb-* tokens.
import type { CSSProperties } from 'react';
import type { SensorState } from '../../core/telemetry';
import { binLevel } from '../../core/recyclebin';
import { formatBytes } from '../../core/format';
import './Recyclebin.css';

type Props = {
	sensors?: Record<string, SensorState>;
	warnGb?: number;
	color?: string;
};

const scalar = (s?: SensorState): number | null =>
	s?.value && s.value.kind === 'scalar' ? s.value.value : null;

export default function Recyclebin({ sensors = {}, warnGb = 0, color }: Props) {
	const items = scalar(sensors.items);
	const bytes = scalar(sensors.bytes);
	const level = binLevel(items, bytes, warnGb * 1e9);
	const vars = color ? ({ '--rb-accent': color } as CSSProperties) : undefined;

	return (
		<div className="recyclebin np-recyclebin" style={vars} data-level={level}>
			<span className="rb-icon" role="img" aria-label="Recycle Bin">
				🗑️
			</span>
			<div className="rb-body">
				{level === 'empty' ? (
					<span className="rb-empty" data-part="value">
						Empty
					</span>
				) : (
					<>
						<span className="rb-count" data-part="value">
							{items} item{items === 1 ? '' : 's'}
						</span>
						<span className="rb-size">{formatBytes(bytes ?? 0, 0)}</span>
					</>
				)}
			</div>
		</div>
	);
}
