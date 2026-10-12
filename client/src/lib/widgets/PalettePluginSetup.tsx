import type { TelemetryHub } from '../core/telemetry';
import { statusDotFrom } from './plugin';
import { useSensor } from './useSensor';

export default function PalettePluginSetup({
	hub,
	id,
	name,
	sensor,
	onConfigure
}: {
	hub: TelemetryHub;
	id: string;
	name: string;
	sensor: string;
	onConfigure(id: string): void;
}) {
	const state = useSensor(hub, sensor);
	const raw = state.value?.kind === 'text' ? state.value.value : null;
	const status = raw ? statusDotFrom(raw) : { state: 'off', label: 'Setup status unknown' };
	if (raw === 'unconfigured') status.state = 'warn';
	return (
		<span className="palette-plugin-setup">
			<span
				className={`palette-plugin-status palette-plugin-status--${status.state}`}
				role="status"
			>
				<span aria-hidden="true">●</span> {status.label}
			</span>
			<button
				type="button"
				className="palette-configure"
				aria-label={`Configure ${name}`}
				onClick={() => onConfigure(id)}
			>
				Configure
			</button>
		</span>
	);
}
