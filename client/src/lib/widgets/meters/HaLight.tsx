// Interactive HA meter (molecule): a light toggle + an optional brightness slider for dimmable
// lights. Reads on/off + brightness/capabilities from the entity's JSON state (binds: 'json'); a
// click/slide calls the `onControl` callback that WidgetHost bubbles to Canvas, which makes the
// Tauri `ha_call_service` call. The meter stays prop-only and Tauri-free (AGENTS.md §6); the
// service_data is built by the pure core/haControls helpers. Catches clicks via `interactive: true`.
import {
	brightnessToPct,
	lightBrightnessPct,
	lightSupports,
	type LightAttrs
} from '../../core/haControls';
import type { ControlEvent } from '../meterProps';
import './HaLight.css';

type HaState = { state?: string; attributes?: Record<string, unknown> };

type Props = {
	value?: unknown;
	label?: string;
	onControl?: (e: ControlEvent) => void;
	showBrightness?: boolean;
};

export default function HaLight({ value = null, label, onControl, showBrightness = true }: Props) {
	const s = (value ?? null) as HaState | null;
	const on = s?.state === 'on';
	const attrs = (s?.attributes ?? {}) as LightAttrs & Record<string, unknown>;
	const name = label ?? (attrs.friendly_name as string | undefined) ?? 'Light';
	const dimmable = showBrightness && on && lightSupports(attrs, 'brightness');
	const pct = brightnessToPct(attrs.brightness as number | undefined);

	const toggle = () => onControl?.({ domain: 'light', service: 'toggle' });
	const setBrightness = (p: number) => {
		const call = lightBrightnessPct(p);
		onControl?.({ domain: 'light', service: call.service, data: call.data });
	};

	return (
		<div className={`ha-light np-ha-light${on ? ' on' : ''}`} data-part="root">
			<button type="button" className="ha-light-toggle" data-part="toggle" onClick={toggle}>
				<span className="label" data-part="label">
					{name}
				</span>
				<span className="state" data-part="state">
					{on ? 'ON' : 'OFF'}
				</span>
			</button>
			{dimmable && (
				<input
					type="range"
					min={1}
					max={100}
					value={pct}
					className="ha-light-dim"
					data-part="brightness"
					aria-label={`${name} brightness`}
					onChange={(e) => setBrightness(Number(e.currentTarget.value))}
				/>
			)}
		</div>
	);
}
