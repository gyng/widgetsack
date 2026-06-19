// Presentational HA meter (molecule): a binary_sensor, with device_class-aware wording so an `on`
// reads as "Open" / "Motion" / "Wet" etc. instead of a bare ON. Read-only; the `value` is the raw
// HA state object (binds: 'json'). Prop-only, themeable via tokens (AGENTS.md §6).
import './HaControls.css';

type HaState = { state?: string; attributes?: Record<string, unknown> };

type Props = {
	value?: unknown;
	label?: string;
};

// [on-word, off-word] per device_class — the common subset; anything else falls back to ON/OFF.
const CLASS_WORDS: Record<string, [string, string]> = {
	door: ['Open', 'Closed'],
	window: ['Open', 'Closed'],
	garage_door: ['Open', 'Closed'],
	opening: ['Open', 'Closed'],
	lock: ['Unlocked', 'Locked'],
	motion: ['Motion', 'Clear'],
	occupancy: ['Occupied', 'Clear'],
	presence: ['Home', 'Away'],
	moisture: ['Wet', 'Dry'],
	smoke: ['Smoke', 'Clear'],
	gas: ['Gas', 'Clear'],
	problem: ['Problem', 'OK'],
	connectivity: ['Connected', 'Disconnected'],
	battery: ['Low', 'OK'],
	power: ['On', 'Off']
};

export default function HaBinarySensor({ value = null, label }: Props) {
	const s = (value ?? null) as HaState | null;
	const attrs = s?.attributes ?? {};
	const name = label ?? (attrs.friendly_name as string | undefined) ?? '—';
	const state = s?.state ?? '—';
	const on = state === 'on';
	const dc = attrs.device_class as string | undefined;
	const words = (dc && CLASS_WORDS[dc]) || ['ON', 'OFF'];
	const text = state === 'on' ? words[0] : state === 'off' ? words[1] : state;

	return (
		<div className={`ha-binary np-ha-binary${on ? ' on' : ''}`} data-part="root">
			<span className="label" data-part="label">
				{name}
			</span>
			<span className="value" data-part="value">
				{text}
			</span>
		</div>
	);
}
