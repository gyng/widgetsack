// Interactive HA meter (molecule): a one-tap scene activator. A scene has no on/off state, so this
// is a button labelled with the scene name that emits onControl (scene.turn_on). Prop-only.
import type { ControlEvent } from '../meterProps';
import './HaControls.css';

type HaState = { attributes?: Record<string, unknown> };

type Props = {
	value?: unknown;
	label?: string;
	onControl?: (e: ControlEvent) => void;
};

export default function HaScene({ value = null, label, onControl }: Props) {
	const s = (value ?? null) as HaState | null;
	const name = label ?? (s?.attributes?.friendly_name as string | undefined) ?? 'Scene';

	return (
		<button
			type="button"
			className="ha-scene np-ha-scene"
			data-part="root"
			onClick={() => onControl?.({ domain: 'scene', service: 'turn_on' })}
		>
			<span className="icon" data-part="icon" aria-hidden="true">
				▶
			</span>
			<span className="label" data-part="label">
				{name}
			</span>
		</button>
	);
}
