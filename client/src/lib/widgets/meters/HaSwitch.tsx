// Interactive HA meter (molecule): a switch toggle (on/off). Reads state from the entity JSON
// (binds: 'json'); a tap emits onControl (switch.toggle), which Canvas turns into ha_call_service.
// Prop-only + Tauri-free (AGENTS.md §6).
import type { ControlEvent } from '../meterProps';
import { haTileState } from '../../core/haTileState';
import HaTileNotice from './HaTileNotice';
import './HaControls.css';

type HaState = { state?: string; attributes?: Record<string, unknown> };

type Props = {
	value?: unknown;
	/** The `ha.status` sample (host-supplied): undefined = not wired, null = plugin not configured. */
	haStatus?: string | null;
	label?: string;
	onControl?: (e: ControlEvent) => void;
};

export default function HaSwitch({ value = null, haStatus, label, onControl }: Props) {
	const s = (value ?? null) as HaState | null;
	const on = s?.state === 'on';
	const name = label ?? (s?.attributes?.friendly_name as string | undefined) ?? 'Switch';

	// No live data (plugin unset / offline / entity unavailable / still waiting) → the shared notice.
	const tile = haTileState(haStatus, value);
	if (tile.kind !== 'ok')
		return <HaTileNotice className="ha-switch np-ha-switch" label={name} tile={tile} />;

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
