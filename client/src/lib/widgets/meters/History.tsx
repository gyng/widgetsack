import type { SensorState } from '../../core/telemetry';
import { historyScale, historySummary, historyWindow } from '../../core/dashboard';
import Sparkline from './Sparkline';
import './Dashboard.css';
const COLORS = [
	'#77c4d3',
	'#ffbc77',
	'#c5a3ff',
	'#9bd385',
	'#f68bbf',
	'#79a8ff',
	'#e5d46f',
	'#ee8272'
];
export default function History({
	sensors = {},
	label = 'History',
	seconds = 60,
	fixedScale = false,
	min = 0,
	max = 100,
	threshold = 80,
	showThreshold = false,
	showStats = true
}: {
	sensors?: Record<string, SensorState>;
	label?: string;
	seconds?: number;
	fixedScale?: boolean;
	min?: number;
	max?: number;
	threshold?: number;
	showThreshold?: boolean;
	showStats?: boolean;
}) {
	const sampleCount = historyWindow(seconds);
	const lines = Object.entries(sensors).map(([id, s]) => ({
		id,
		history: s.history.slice(-sampleCount).filter(Number.isFinite)
	}));
	const [lo, hi] = historyScale(
		lines.map((l) => l.history),
		fixedScale ? min : null,
		fixedScale ? max : null
	);
	const band = Math.max(0, Math.min(100, (100 * (hi - threshold)) / (hi - lo)));
	return (
		<section className="np-dashboard" aria-label={label}>
			<header>
				{label} · {lo.toFixed(1)}–{hi.toFixed(1)}
			</header>
			<div className="history-plot">
				{showThreshold && (
					<div
						className="history-band"
						style={{ top: 0, height: `${band}%` }}
						title={`Threshold ${threshold}`}
					/>
				)}
				{lines.map((l, i) => (
					<div className="history-line" key={l.id}>
						<Sparkline
							history={l.history}
							min={lo}
							max={hi}
							seconds={sampleCount}
							fill={false}
							color={COLORS[i % COLORS.length]}
						/>
					</div>
				))}
			</div>
			<div className="history-legend">
				{lines.map((l, i) => {
					const stats = historySummary(l.history);
					return (
						<span key={l.id} style={{ color: COLORS[i % COLORS.length] }}>
							{l.id}
							{showStats && stats
								? ` · min ${stats.min.toFixed(1)} / avg ${stats.average.toFixed(1)} / max ${stats.max.toFixed(1)}`
								: ''}
						</span>
					);
				})}
			</div>
		</section>
	);
}
