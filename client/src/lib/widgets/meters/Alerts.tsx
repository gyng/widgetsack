import type { AlertRule } from '../../core/dashboard';
import './Dashboard.css';
export default function Alerts({
	alerts,
	label,
	snoozeMin,
	editMode,
	onSnooze
}: {
	alerts: AlertRule[];
	label: string;
	snoozeMin: number;
	editMode: boolean;
	onSnooze: (id: string) => void;
}) {
	if (!alerts.length && !editMode) return <div hidden data-widget-interactive="none" />;
	return (
		<section className="np-dashboard" aria-label={label}>
			<header>{label}</header>
			{!alerts.length && <span>All clear</span>}
			{alerts.map((a) => (
				<div className="dashboard-row" key={a.id}>
					<span role="status">{a.label}</span>
					<button
						disabled={editMode}
						onClick={() => onSnooze(a.id)}
						aria-label={`Snooze ${a.label}`}
					>
						Snooze {snoozeMin}m
					</button>
				</div>
			))}
		</section>
	);
}
