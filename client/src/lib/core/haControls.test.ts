import { describe, expect, it } from 'vitest';
import {
	brightnessToPct,
	climateNextHvacMode,
	climateNudge,
	climateSetFanMode,
	climateSetHvacMode,
	climateSetTemperature,
	climateUsesRange,
	coverSetPosition,
	entityDomain,
	fanSetPercentage,
	inputNumberSetValue,
	inputSelectOption,
	inputTextSetValue,
	lightBrightnessPct,
	lightColorTempKelvin,
	lightRgb,
	lightSupports
} from './haControls';

describe('haControls — light', () => {
	it('reads capabilities from supported_color_modes', () => {
		expect(lightSupports({ supported_color_modes: ['onoff'] }, 'brightness')).toBe(false);
		expect(lightSupports({ supported_color_modes: ['brightness'] }, 'brightness')).toBe(true);
		expect(lightSupports({ supported_color_modes: ['color_temp'] }, 'color_temp')).toBe(true);
		expect(lightSupports({ supported_color_modes: ['color_temp'] }, 'rgb')).toBe(false);
		expect(lightSupports({ supported_color_modes: ['rgbw'] }, 'rgb')).toBe(true);
	});

	it('converts brightness 0..255 to a percentage', () => {
		expect(brightnessToPct(undefined)).toBe(0);
		expect(brightnessToPct(0)).toBe(0);
		expect(brightnessToPct(255)).toBe(100);
		expect(brightnessToPct(128)).toBe(50);
	});

	it('builds turn_on with a clamped brightness_pct', () => {
		expect(lightBrightnessPct(50)).toEqual({ service: 'turn_on', data: { brightness_pct: 50 } });
		expect(lightBrightnessPct(150).data.brightness_pct).toBe(100);
		expect(lightBrightnessPct(-5).data.brightness_pct).toBe(0);
	});

	it('clamps color_temp_kelvin to the device range', () => {
		const attrs = { min_color_temp_kelvin: 2200, max_color_temp_kelvin: 4000 };
		expect(lightColorTempKelvin(3000, attrs).data.color_temp_kelvin).toBe(3000);
		expect(lightColorTempKelvin(9000, attrs).data.color_temp_kelvin).toBe(4000);
		expect(lightColorTempKelvin(1000, attrs).data.color_temp_kelvin).toBe(2200);
	});

	it('clamps rgb components to 0..255', () => {
		expect(lightRgb(300, -10, 128).data.rgb_color).toEqual([255, 0, 128]);
	});
});

describe('haControls — climate', () => {
	it('detects single-setpoint vs range', () => {
		expect(climateUsesRange({ temperature: 21 })).toBe(false);
		expect(climateUsesRange({ target_temp_high: 24, target_temp_low: 18 })).toBe(true);
	});

	it('builds set_temperature clamped to min/max', () => {
		const attrs = { min_temp: 10, max_temp: 30 };
		expect(climateSetTemperature(21, attrs).data.temperature).toBe(21);
		expect(climateSetTemperature(99, attrs).data.temperature).toBe(30);
		expect(climateSetTemperature(0, attrs).data.temperature).toBe(10);
	});

	it('nudges the setpoint by ± one step from the current target', () => {
		const attrs = { temperature: 21, target_temp_step: 0.5, min_temp: 7, max_temp: 35 };
		expect(climateNudge(attrs, 1).data.temperature).toBe(21.5);
		expect(climateNudge(attrs, -1).data.temperature).toBe(20.5);
		// Clamped at the max.
		expect(climateNudge({ temperature: 35, max_temp: 35 }, 1).data.temperature).toBe(35);
	});

	it('builds set_hvac_mode', () => {
		expect(climateSetHvacMode('heat')).toEqual({
			service: 'set_hvac_mode',
			data: { hvac_mode: 'heat' }
		});
	});

	it('cycles to the next hvac mode, wrapping', () => {
		const attrs = { hvac_modes: ['off', 'cool', 'heat'] };
		expect(climateNextHvacMode(attrs, 'off')).toBe('cool');
		expect(climateNextHvacMode(attrs, 'heat')).toBe('off');
		// Unknown current / empty list → unchanged.
		expect(climateNextHvacMode(attrs, 'dry')).toBe('off');
		expect(climateNextHvacMode({}, 'cool')).toBe('cool');
	});

	it('builds set_fan_mode (A/C fan speed)', () => {
		expect(climateSetFanMode('high')).toEqual({
			service: 'set_fan_mode',
			data: { fan_mode: 'high' }
		});
	});
});

describe('haControls — fan / cover / input helpers', () => {
	it('builds fan.set_percentage clamped + rounded', () => {
		expect(fanSetPercentage(40)).toEqual({ service: 'set_percentage', data: { percentage: 40 } });
		expect(fanSetPercentage(140).data.percentage).toBe(100);
		expect(fanSetPercentage(-5).data.percentage).toBe(0);
	});

	it('builds cover.set_cover_position clamped + rounded', () => {
		expect(coverSetPosition(75)).toEqual({
			service: 'set_cover_position',
			data: { position: 75 }
		});
		expect(coverSetPosition(120).data.position).toBe(100);
	});

	it('builds input_number.set_value clamped to min/max', () => {
		const attrs = { min: 5, max: 30 };
		expect(inputNumberSetValue(20, attrs).data.value).toBe(20);
		expect(inputNumberSetValue(99, attrs).data.value).toBe(30);
		expect(inputNumberSetValue(0, attrs).data.value).toBe(5);
	});

	it('builds input_select.select_option + input_text.set_value', () => {
		expect(inputSelectOption('Home')).toEqual({
			service: 'select_option',
			data: { option: 'Home' }
		});
		expect(inputTextSetValue('hi')).toEqual({ service: 'set_value', data: { value: 'hi' } });
	});

	it('reads the domain from an entity_id', () => {
		expect(entityDomain('input_number.x')).toBe('input_number');
		expect(entityDomain('light.kitchen')).toBe('light');
		expect(entityDomain(undefined)).toBe('');
	});
});
