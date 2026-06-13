// Self-sourcing storage meter: one usage bar per volume. Like Cpu it reads the telemetry hub from
// context (the disk ids are dynamic, discovered at runtime) rather than a single bound sensor —
// `binds:'none'`. The per-disk enumeration is demand-gated on any active `disk.*` id, but the volume
// letters aren't known up front, so we subscribe to a sentinel `disk._probe` to signal the demand and
// then discover the real `disk.<letter>.*` ids from the hub. Capacity only (used.pct + used/total);
// bind a Sparkline to `disk.<letter>.read`/`.write` for I/O graphs.
import { useContext, useEffect, useState, type CSSProperties } from 'react';
import { TelemetryHubContext } from '../telemetryContext';
import { diskLetters } from '../../core/disks';
import { formatBytes } from '../../core/format';
import './Disks.css';

type Vol = { letter: string; pct: number | null; used: number | null; total: number | null };
type Props = { showBytes?: boolean; color?: string };

const PROBE = 'disk._probe'; // demand sentinel — gates the enumeration on; never emits a sample

/** Structural equality so a re-read that found no change returns the SAME array → React bails the
 * re-render (capacity barely moves, so this widget is idle after the first read). */
const sameVols = (a: Vol[], b: Vol[]): boolean =>
	a.length === b.length &&
	a.every((x, i) => {
		const y = b[i];
		return x.letter === y.letter && x.pct === y.pct && x.used === y.used && x.total === y.total;
	});

export default function Disks({ showBytes = true, color }: Props) {
	const hub = useContext(TelemetryHubContext);
	const [vols, setVols] = useState<Vol[]>([]);

	useEffect(() => {
		if (!hub) return;
		const sc = (id: string): number | null => {
			const v = hub.sensor(id).getSnapshot().value;
			return v && v.kind === 'scalar' ? v.value : null;
		};
		const read = (): void => {
			const next = diskLetters(hub.sensorIds()).map((l) => ({
				letter: l,
				pct: sc(`disk.${l}.used.pct`),
				used: sc(`disk.${l}.used`),
				total: sc(`disk.${l}.total`)
			}));
			setVols((prev) => (sameVols(prev, next) ? prev : next));
		};
		const probe = hub.sensor(PROBE).subscribe(() => undefined); // demand only (keeps disks sampled)
		read();
		// Capacity changes slowly + the ids are dynamic (no single fixed id to ride), so re-read the
		// hub snapshots on a relaxed cadence — the read is cheap and the dedupe above gates re-renders,
		// so a steady disk costs one cheap snapshot scan every 5s and zero React work.
		const timer = window.setInterval(read, 5000);
		return () => {
			probe();
			window.clearInterval(timer);
		};
	}, [hub]);

	const vars = color ? ({ '--disk-accent': color } as CSSProperties) : undefined;
	return (
		<div className="disks np-disks" style={vars}>
			{vols.length === 0 ? (
				<div className="disk-empty" data-part="empty">
					—
				</div>
			) : (
				vols.map((v) => {
					const pct = v.pct == null ? 0 : Math.max(0, Math.min(100, v.pct));
					return (
						<div
							key={v.letter}
							className="disk-row"
							style={{ '--disk-pct': `${pct}%` } as CSSProperties}
							data-level={pct >= 90 ? 'full' : undefined}
						>
							<span className="disk-label">{v.letter}:</span>
							<div className="disk-bar">
								<span className="disk-fill" />
							</div>
							<span className="disk-meta">
								{v.pct == null ? '' : `${Math.round(pct)}%`}
								{showBytes && v.used != null && v.total != null
									? ` · ${formatBytes(v.used, 0)}/${formatBytes(v.total, 0)}`
									: ''}
							</span>
						</div>
					);
				})
			)}
		</div>
	);
}
