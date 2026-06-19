// Interactive HA meter (molecule): a lock toggle. Reads locked/unlocked from the entity JSON
// (binds: 'json'); a tap emits onControl (lock.lock / lock.unlock) which Canvas turns into
// ha_call_service. Prop-only (AGENTS.md §6).
import type { ControlEvent } from '../meterProps';
import './HaControls.css';

type HaState = { state?: string; attributes?: Record<string, unknown> };

type Props = {
	value?: unknown;
	label?: string;
	onControl?: (e: ControlEvent) => void;
};

export default function HaLock({ value = null, label, onControl }: Props) {
	const s = (value ?? null) as HaState | null;
	const state = s?.state ?? '—';
	const locked = state === 'locked';
	const name = label ?? (s?.attributes?.friendly_name as string | undefined) ?? 'Lock';

	return (
		<button
			type="button"
			className={`ha-lock np-ha-lock${locked ? ' locked' : ''}`}
			data-part="root"
			aria-pressed={locked}
			onClick={() => onControl?.({ domain: 'lock', service: locked ? 'unlock' : 'lock' })}
		>
			<span className="icon" data-part="icon" aria-hidden="true">
				{locked ? '🔒' : '🔓'}
			</span>
			<span className="label" data-part="label">
				{name}
			</span>
			<span className="state" data-part="state">
				{state}
			</span>
		</button>
	);
}
