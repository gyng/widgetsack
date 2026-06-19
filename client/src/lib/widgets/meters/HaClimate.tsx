// Interactive HA meter (molecule): a climate / A-C readout (current → target setpoint) with
// controls — ± setpoint nudge for single-setpoint thermostats, a tap-to-cycle HVAC mode button
// (off/cool/heat/…), and an A/C fan-mode selector (auto/low/high). Reads from the entity's JSON
// attributes (binds: 'json'); each control emits onControl that WidgetHost bubbles to Canvas
// (ha_call_service). Range (high/low) thermostats display the setpoint read-only. Prop-only,
// token-themeable (AGENTS.md §6); service_data is built by the pure core/haControls helpers.
import {
	climateNextHvacMode,
	climateNudge,
	climateSetFanMode,
	climateSetHvacMode,
	climateUsesRange,
	type ClimateAttrs
} from '../../core/haControls';
import type { ControlEvent } from '../meterProps';
import './HaClimate.css';

type HaState = { state?: string; attributes?: Record<string, unknown> };

type Props = {
	value?: unknown;
	label?: string;
	onControl?: (e: ControlEvent) => void;
	showMode?: boolean; // tap-to-cycle HVAC mode button
	showTemp?: boolean; // ± setpoint buttons
	showFan?: boolean; // fan-mode selector
};

export default function HaClimate({
	value = null,
	label,
	onControl,
	showMode = true,
	showTemp = true,
	showFan = true
}: Props) {
	const s = (value ?? null) as HaState | null;
	const attrs = (s?.attributes ?? {}) as ClimateAttrs & Record<string, unknown>;
	const name = label ?? (attrs.friendly_name as string | undefined) ?? 'Climate';
	const mode = s?.state ?? '—';
	const current = attrs.current_temperature as number | undefined;
	const target = attrs.temperature as number | undefined;
	const fmt = (n: number | undefined): string => (n === undefined ? '—' : `${n}°`);

	const hvacModes = (attrs.hvac_modes as string[] | undefined) ?? [];
	const fanModes = (attrs.fan_modes as string[] | undefined) ?? [];
	const fanMode = attrs.fan_mode as string | undefined;

	// Single-setpoint controllable thermostats get nudge buttons; range/off/unavailable display only.
	const canSetTemp =
		showTemp && !!onControl && mode !== 'off' && mode !== 'unavailable' && !climateUsesRange(attrs);
	const canCycleMode = showMode && !!onControl && hvacModes.length > 1;
	const canSetFan = showFan && !!onControl && fanModes.length > 0;

	const emit = (call: { service: string; data: Record<string, unknown> }): void =>
		onControl?.({ domain: 'climate', service: call.service, data: call.data });
	const nudge = (dir: 1 | -1) => emit(climateNudge(attrs, dir));
	const cycleMode = () => emit(climateSetHvacMode(climateNextHvacMode(attrs, mode)));

	return (
		<div className="ha-climate np-ha-climate" data-part="root">
			<span className="label" data-part="label">
				{name}
			</span>
			<span className="temps" data-part="value">
				{fmt(current)} → {fmt(target)}
			</span>
			{canCycleMode ? (
				<button
					type="button"
					className="mode mode-btn"
					data-part="mode"
					aria-label={`${name} mode (tap to change)`}
					onClick={cycleMode}
				>
					{mode}
				</button>
			) : (
				<span className="mode" data-part="mode">
					{mode}
				</span>
			)}
			{canSetTemp && (
				<div className="ha-climate-set" data-part="controls">
					<button
						type="button"
						className="ha-climate-btn"
						aria-label={`Lower ${name} setpoint`}
						onClick={() => nudge(-1)}
					>
						−
					</button>
					<button
						type="button"
						className="ha-climate-btn"
						aria-label={`Raise ${name} setpoint`}
						onClick={() => nudge(1)}
					>
						＋
					</button>
				</div>
			)}
			{canSetFan && (
				<select
					className="ha-climate-fan"
					data-part="fan"
					value={fanMode ?? ''}
					aria-label={`${name} fan mode`}
					onChange={(e) => emit(climateSetFanMode(e.currentTarget.value))}
				>
					{fanMode === undefined && <option value="">fan…</option>}
					{/* Keep the controlled value matched even if HA reports a fan_mode not in fan_modes. */}
					{fanMode !== undefined && !fanModes.includes(fanMode) && (
						<option value={fanMode}>{fanMode}</option>
					)}
					{fanModes.map((m) => (
						<option key={m} value={m}>
							{m}
						</option>
					))}
				</select>
			)}
		</div>
	);
}
