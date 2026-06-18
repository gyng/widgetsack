// Pure builders of Home Assistant light/climate `service_data`, driven by the entity's live
// attributes so a meter offers only valid actions within the device's real ranges. Domain logic
// (AGENTS.md §5): no React/Tauri — attributes in, {service, data} out. The container (Canvas) makes
// the actual ha_call_service call; the meter just emits the {domain, service, data} control event.

export type ServiceCall = { service: string; data: Record<string, unknown> };

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round1 = (n: number): number => Math.round(n * 10) / 10;

// ---- light ----

export type LightAttrs = {
	brightness?: number; // 0..255 (HA's native scale)
	supported_color_modes?: string[];
	min_color_temp_kelvin?: number;
	max_color_temp_kelvin?: number;
};

/** Whether a light supports a capability, read from its `supported_color_modes`. */
export function lightSupports(
	attrs: LightAttrs,
	cap: 'brightness' | 'color_temp' | 'rgb'
): boolean {
	const modes = attrs.supported_color_modes ?? [];
	if (cap === 'brightness') return modes.some((m) => m !== 'onoff' && m !== 'unknown');
	if (cap === 'color_temp') return modes.includes('color_temp');
	return modes.some((m) => ['rgb', 'rgbw', 'rgbww', 'hs', 'xy'].includes(m));
}

/** Current brightness as a 0..100 percentage (HA stores 0..255). */
export function brightnessToPct(brightness?: number): number {
	if (brightness == null) return 0;
	return Math.round(clamp((brightness / 255) * 100, 0, 100));
}

/** light.turn_on with a brightness percentage (0..100, clamped + rounded). */
export function lightBrightnessPct(pct: number): ServiceCall {
	return { service: 'turn_on', data: { brightness_pct: Math.round(clamp(pct, 0, 100)) } };
}

/** light.turn_on with a colour temperature in Kelvin, clamped to the device range. */
export function lightColorTempKelvin(kelvin: number, attrs: LightAttrs): ServiceCall {
	const lo = attrs.min_color_temp_kelvin ?? 2000;
	const hi = attrs.max_color_temp_kelvin ?? 6500;
	return { service: 'turn_on', data: { color_temp_kelvin: Math.round(clamp(kelvin, lo, hi)) } };
}

/** light.turn_on with an rgb_color triple (each clamped 0..255). */
export function lightRgb(r: number, g: number, b: number): ServiceCall {
	const c = (n: number): number => Math.round(clamp(n, 0, 255));
	return { service: 'turn_on', data: { rgb_color: [c(r), c(g), c(b)] } };
}

// ---- climate ----

export type ClimateAttrs = {
	hvac_modes?: string[];
	fan_modes?: string[];
	fan_mode?: string;
	min_temp?: number;
	max_temp?: number;
	target_temp_step?: number;
	current_temperature?: number;
	temperature?: number;
	target_temp_high?: number;
	target_temp_low?: number;
};

/** Whether this climate entity uses a high/low RANGE setpoint vs a single `temperature`. */
export function climateUsesRange(attrs: ClimateAttrs): boolean {
	return attrs.target_temp_high != null || attrs.target_temp_low != null;
}

/** climate.set_temperature for a single-setpoint device, clamped to min/max. */
export function climateSetTemperature(temp: number, attrs: ClimateAttrs): ServiceCall {
	const lo = attrs.min_temp ?? 7;
	const hi = attrs.max_temp ?? 35;
	return { service: 'set_temperature', data: { temperature: round1(clamp(temp, lo, hi)) } };
}

/** Nudge the single setpoint by ± one step (default 0.5°) from the current target. */
export function climateNudge(attrs: ClimateAttrs, dir: 1 | -1): ServiceCall {
	const step = attrs.target_temp_step ?? 0.5;
	const cur = attrs.temperature ?? attrs.current_temperature ?? 20;
	return climateSetTemperature(round1(cur + dir * step), attrs);
}

/** climate.set_hvac_mode (e.g. 'heat', 'cool', 'off'). */
export function climateSetHvacMode(mode: string): ServiceCall {
	return { service: 'set_hvac_mode', data: { hvac_mode: mode } };
}

/** The next hvac mode in the entity's supported list, wrapping — for a tap-to-cycle mode button. */
export function climateNextHvacMode(attrs: ClimateAttrs, current: string): string {
	const modes = attrs.hvac_modes ?? [];
	if (modes.length === 0) return current;
	const i = modes.indexOf(current);
	return modes[(i + 1) % modes.length];
}

/** climate.set_fan_mode (e.g. 'auto', 'low', 'high') — A/C fan speed. */
export function climateSetFanMode(mode: string): ServiceCall {
	return { service: 'set_fan_mode', data: { fan_mode: mode } };
}

// ---- generic ----

/** The domain of an entity_id, e.g. 'light.kitchen' → 'light' ('' when unknown). */
export function entityDomain(entityId?: string): string {
	return entityId ? entityId.split('.')[0] : '';
}

// ---- fan ----

export type FanAttrs = {
	percentage?: number | null;
	percentage_step?: number;
	preset_modes?: string[];
	preset_mode?: string;
	oscillating?: boolean;
};

/** fan.set_percentage (0..100, clamped + rounded). */
export function fanSetPercentage(pct: number): ServiceCall {
	return { service: 'set_percentage', data: { percentage: Math.round(clamp(pct, 0, 100)) } };
}

// ---- cover ----

/** cover.set_cover_position (0 = closed … 100 = open, clamped + rounded). */
export function coverSetPosition(pct: number): ServiceCall {
	return { service: 'set_cover_position', data: { position: Math.round(clamp(pct, 0, 100)) } };
}

// ---- input_* helpers ----

export type InputNumberAttrs = { min?: number; max?: number; step?: number };

/** input_number.set_value, clamped to the helper's configured min/max. */
export function inputNumberSetValue(value: number, attrs: InputNumberAttrs): ServiceCall {
	const lo = attrs.min ?? 0;
	const hi = attrs.max ?? 100;
	return { service: 'set_value', data: { value: round1(clamp(value, lo, hi)) } };
}

/** input_select.select_option. */
export function inputSelectOption(option: string): ServiceCall {
	return { service: 'select_option', data: { option } };
}

/** input_text.set_value. */
export function inputTextSetValue(value: string): ServiceCall {
	return { service: 'set_value', data: { value } };
}
