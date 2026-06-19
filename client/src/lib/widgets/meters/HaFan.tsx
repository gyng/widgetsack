// Interactive HA meter (molecule): a fan toggle + optional speed slider + oscillate toggle. Reads
// on/off + percentage + oscillating from the entity JSON (binds: 'json'); controls emit onControl
// (fan.toggle / set_percentage / oscillate) which Canvas turns into ha_call_service. service_data is
// built by the pure core/haControls helper. Prop-only (AGENTS.md §6).
import { fanSetPercentage, type FanAttrs } from '../../core/haControls';
import type { ControlEvent } from '../meterProps';
import './HaControls.css';

type HaState = { state?: string; attributes?: Record<string, unknown> };

type Props = {
	value?: unknown;
	label?: string;
	onControl?: (e: ControlEvent) => void;
	showSpeed?: boolean;
	showOscillate?: boolean;
};

export default function HaFan({
	value = null,
	label,
	onControl,
	showSpeed = true,
	showOscillate = true
}: Props) {
	const s = (value ?? null) as HaState | null;
	const on = s?.state === 'on';
	const attrs = (s?.attributes ?? {}) as FanAttrs & Record<string, unknown>;
	const name = label ?? (attrs.friendly_name as string | undefined) ?? 'Fan';
	const hasSpeed = showSpeed && on && attrs.percentage != null;
	const pct = Math.round((attrs.percentage as number | undefined) ?? 0);
	const canOscillate = showOscillate && on && attrs.oscillating !== undefined;

	const toggle = () => onControl?.({ domain: 'fan', service: 'toggle' });
	const setSpeed = (p: number) => {
		const call = fanSetPercentage(p);
		onControl?.({ domain: 'fan', service: call.service, data: call.data });
	};
	const oscillate = () =>
		onControl?.({ domain: 'fan', service: 'oscillate', data: { oscillating: !attrs.oscillating } });

	return (
		<div className={`ha-fan np-ha-fan${on ? ' on' : ''}`} data-part="root">
			<button type="button" className="ha-fan-toggle" data-part="toggle" onClick={toggle}>
				<span className="label" data-part="label">
					{name}
				</span>
				<span className="state" data-part="state">
					{on ? (hasSpeed ? `${pct}%` : 'ON') : 'OFF'}
				</span>
			</button>
			{hasSpeed && (
				<input
					type="range"
					min={1}
					max={100}
					value={pct}
					className="ha-fan-speed"
					data-part="speed"
					aria-label={`${name} speed`}
					onChange={(e) => setSpeed(Number(e.currentTarget.value))}
				/>
			)}
			{canOscillate && (
				<button
					type="button"
					className={`ha-fan-osc${attrs.oscillating ? ' on' : ''}`}
					data-part="oscillate"
					aria-pressed={!!attrs.oscillating}
					aria-label={`${name} oscillate`}
					onClick={oscillate}
				>
					⟲
				</button>
			)}
		</div>
	);
}
