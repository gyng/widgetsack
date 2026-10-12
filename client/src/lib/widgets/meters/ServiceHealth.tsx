import type { ServiceHealth as Snapshot } from '../plugins/service-health-commands';
import { serviceHealthLevel } from '../../core/serviceHealth';
import './Dashboard.css';
export default function ServiceHealth({
	result,
	label,
	url,
	slowMs,
	warnDays,
	busy
}: {
	result: Snapshot | null;
	label: string;
	url: string;
	slowMs: number;
	warnDays: number;
	busy: boolean;
}) {
	const level = serviceHealthLevel(result, slowMs, warnDays);
	return (
		<section className="np-dashboard" aria-label={label} data-state={level.state}>
			<header>{label}</header>
			<span title={url}>
				{!url
					? 'Set an HTTP or HTTPS endpoint in properties.'
					: !result
						? 'Checking…'
						: `${level.label} · ${result.status ?? 'no response'} · ${Math.round(result.latencyMs)} ms`}
				{busy && result ? ' · checking' : ''}
			</span>
			{result?.certificateDays !== null && result?.certificateDays !== undefined && (
				<span>Certificate expires in {result.certificateDays} days</span>
			)}
			{result?.error && <span role="alert">{result.error}</span>}
		</section>
	);
}
