// Interactive HA meter (molecule): a switch toggle (on/off). Reads state from the entity JSON
// (binds: 'json'); a tap emits onControl (switch.toggle), which Canvas turns into ha_call_service.
// Prop-only + Tauri-free (AGENTS.md §6).
import type { ControlEvent } from '../meterProps';
import './HaControls.css';

type HaState = { state?: string; attributes?: Record<string, unknown> };

type Props = {
	value?: unknown;
	label?: string;
	onControl?: (e: ControlEvent) => void;
};

export default function HaSwitch({ value = null, label, onControl }: Props) {
	const s = (value ?? null) as HaState | null;
	const on = s?.state === 'on';
	const name = label ?? (s?.attributes?.friendly_name as string | undefined) ?? 'Switch';

	return (
		<button
			type="button"
			className={`ha-switch np-ha-switch${on ? ' on' : ''}`}
			data-part="root"
			aria-pressed={on}
			onClick={() => onControl?.({ domain: 'switch', service: 'toggle' })}
		>
			<span className="label" data-part="label">
				{name}
			</span>
			<span className="state" data-part="state">
				{on ? 'ON' : 'OFF'}
			</span>
		</button>
	);
}
