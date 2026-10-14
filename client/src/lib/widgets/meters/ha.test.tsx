import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import HaSensor from './HaSensor';
import HaLight from './HaLight';
import HaClimate from './HaClimate';

// A minimal HA state object as the Rust proxy forwards it (binds: 'json').
const sensorState = {
	state: '21.4',
	attributes: { friendly_name: 'Living Room Temp', unit_of_measurement: '°C' }
};

describe('HaSensor', () => {
	it('renders friendly name, state and unit', () => {
		const { getByText } = render(<HaSensor value={sensorState} />);
		expect(() => getByText(/Living Room Temp/i)).not.toThrow();
		expect(() => getByText(/21\.4\s*°C/)).not.toThrow();
	});

	it('falls back to placeholders when value is null', () => {
		const { getAllByText } = render(<HaSensor value={null} />);
		expect(getAllByText('—').length).toBeGreaterThan(0);
	});

	it('a config label overrides the friendly name', () => {
		const { getByText } = render(<HaSensor value={sensorState} label="Lounge" />);
		expect(() => getByText('Lounge')).not.toThrow();
	});
});

describe('HaLight', () => {
	const lightOn = { state: 'on', attributes: { friendly_name: 'Kitchen' } };
	const lightOff = { state: 'off', attributes: { friendly_name: 'Kitchen' } };

	it('shows ON/OFF from the entity state', () => {
		expect(() => render(<HaLight value={lightOn} />).getByText('ON')).not.toThrow();
		expect(() => render(<HaLight value={lightOff} />).getByText('OFF')).not.toThrow();
	});

	it('calls onControl (light/toggle) on click', () => {
		let detail: unknown = null;
		const { getByRole } = render(<HaLight value={lightOff} onControl={(e) => (detail = e)} />);
		fireEvent.click(getByRole('button'));
		expect(detail).toEqual({ domain: 'light', service: 'toggle' });
	});

	it('emits a brightness change for a dimmable light', () => {
		const dimmable = {
			state: 'on',
			attributes: {
				friendly_name: 'Kitchen',
				supported_color_modes: ['brightness'],
				brightness: 128
			}
		};
		let detail: unknown = null;
		const { getByRole } = render(<HaLight value={dimmable} onControl={(e) => (detail = e)} />);
		fireEvent.change(getByRole('slider'), { target: { value: '40' } });
		expect(detail).toEqual({ domain: 'light', service: 'turn_on', data: { brightness_pct: 40 } });
	});

	it('shows no brightness slider for a non-dimmable (onoff) light', () => {
		const onoff = {
			state: 'on',
			attributes: { friendly_name: 'Kitchen', supported_color_modes: ['onoff'] }
		};
		const { queryByRole } = render(<HaLight value={onoff} />);
		expect(queryByRole('slider')).toBeNull();
	});
});

describe('HaClimate', () => {
	it('renders current → target temperatures', () => {
		const climate = {
			state: 'heat',
			attributes: { friendly_name: 'Bedroom', current_temperature: 19, temperature: 21 }
		};
		const { getByText } = render(<HaClimate value={climate} />);
		expect(() => getByText(/19°\s*→\s*21°/)).not.toThrow();
		expect(() => getByText(/heat/i)).not.toThrow();
	});

	it('nudges the setpoint with the ± buttons (single-setpoint thermostat)', () => {
		const climate = {
			state: 'heat',
			attributes: {
				friendly_name: 'Bedroom',
				current_temperature: 19,
				temperature: 21,
				target_temp_step: 0.5,
				min_temp: 7,
				max_temp: 35
			}
		};
		let detail: unknown = null;
		const { getByLabelText } = render(
			<HaClimate value={climate} onControl={(e) => (detail = e)} />
		);
		fireEvent.click(getByLabelText('Raise Bedroom setpoint'));
		expect(detail).toEqual({
			domain: 'climate',
			service: 'set_temperature',
			data: { temperature: 21.5 }
		});
	});

	it('stacks rapid nudges on a pending target until the thermostat catches up', () => {
		const state = (temperature: number) => ({
			state: 'heat',
			attributes: { friendly_name: 'Bedroom', temperature, target_temp_step: 0.5 }
		});
		const calls: unknown[] = [];
		const onControl = (e: { data?: Record<string, unknown> }) => calls.push(e.data?.temperature);
		const { getByLabelText, rerender } = render(
			<HaClimate value={state(21)} onControl={onControl} />
		);
		const raise = getByLabelText('Raise Bedroom setpoint');
		fireEvent.click(raise);
		fireEvent.click(raise);
		// The first echo is an intermediate step — the second request is still pending.
		rerender(<HaClimate value={state(21.5)} onControl={onControl} />);
		fireEvent.click(raise);
		expect(calls).toEqual([21.5, 22, 22.5]);
		// Caught up: nudges continue from the reported setpoint.
		rerender(<HaClimate value={state(22.5)} onControl={onControl} />);
		fireEvent.click(getByLabelText('Lower Bedroom setpoint'));
		expect(calls.at(-1)).toBe(22);
		// Someone else changes the setpoint: the pending request is dropped.
		rerender(<HaClimate value={state(18)} onControl={onControl} />);
		fireEvent.click(raise);
		expect(calls.at(-1)).toBe(18.5);
	});

	it('drops a pending target that never lands (failed or ignored call)', () => {
		vi.useFakeTimers();
		try {
			const value = {
				state: 'heat',
				attributes: { friendly_name: 'Bedroom', temperature: 21, target_temp_step: 0.5 }
			};
			const calls: unknown[] = [];
			const onControl = (e: { data?: Record<string, unknown> }) => calls.push(e.data?.temperature);
			const { getByLabelText } = render(<HaClimate value={value} onControl={onControl} />);
			const raise = getByLabelText('Raise Bedroom setpoint');
			fireEvent.click(raise);
			act(() => vi.advanceTimersByTime(10_000));
			fireEvent.click(raise);
			expect(calls).toEqual([21.5, 21.5]);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		[{ current_temperature: 19 }, [19.5, 20]],
		[{}, [20.5, 21]]
	])('stacks nudges without a reported setpoint (%j)', (temps, expected) => {
		const calls: unknown[] = [];
		const { getByLabelText } = render(
			<HaClimate
				value={{ state: 'heat', attributes: { friendly_name: 'Den', ...temps } }}
				onControl={(e) => calls.push(e.data?.temperature)}
			/>
		);
		fireEvent.click(getByLabelText('Raise Den setpoint'));
		fireEvent.click(getByLabelText('Raise Den setpoint'));
		expect(calls).toEqual(expected);
	});

	it('hides setpoint controls for a range thermostat', () => {
		const range = {
			state: 'heat_cool',
			attributes: { friendly_name: 'X', target_temp_high: 24, target_temp_low: 18 }
		};
		const { queryByLabelText } = render(<HaClimate value={range} onControl={() => undefined} />);
		expect(queryByLabelText('Raise X setpoint')).toBeNull();
	});

	it('lowers the setpoint with the − button', () => {
		const climate = {
			state: 'cool',
			attributes: {
				friendly_name: 'Bedroom',
				temperature: 21,
				target_temp_step: 0.5,
				min_temp: 7,
				max_temp: 35
			}
		};
		let detail: unknown = null;
		const { getByLabelText } = render(
			<HaClimate value={climate} onControl={(e) => (detail = e)} />
		);
		fireEvent.click(getByLabelText('Lower Bedroom setpoint'));
		expect(detail).toEqual({
			domain: 'climate',
			service: 'set_temperature',
			data: { temperature: 20.5 }
		});
	});

	it('cycles the HVAC mode with the mode button', () => {
		const climate = {
			state: 'off',
			attributes: { friendly_name: 'Bedroom', hvac_modes: ['off', 'cool', 'heat'] }
		};
		let detail: unknown = null;
		const { getByLabelText } = render(
			<HaClimate value={climate} onControl={(e) => (detail = e)} />
		);
		const btn = getByLabelText('Bedroom mode (tap to change)');
		expect(btn.tagName).toBe('BUTTON');
		expect(btn.textContent).toBe('off');
		fireEvent.click(btn);
		expect(detail).toEqual({
			domain: 'climate',
			service: 'set_hvac_mode',
			data: { hvac_mode: 'cool' }
		});
	});

	it('shows the mode read-only when there is no controllable mode list', () => {
		const climate = {
			state: 'heat',
			attributes: { friendly_name: 'Bedroom', hvac_modes: ['heat'] }
		};
		const { getByText, queryByLabelText } = render(
			<HaClimate value={climate} onControl={() => undefined} />
		);
		// Single-entry list → not a button, just a span.
		expect(queryByLabelText('Bedroom mode (tap to change)')).toBeNull();
		expect(getByText('heat').tagName).toBe('SPAN');
	});

	it('selects an A/C fan mode from the dropdown', () => {
		const climate = {
			state: 'cool',
			attributes: {
				friendly_name: 'Bedroom',
				fan_modes: ['auto', 'low', 'high'],
				fan_mode: 'auto'
			}
		};
		let detail: unknown = null;
		const { getByLabelText } = render(
			<HaClimate value={climate} onControl={(e) => (detail = e)} />
		);
		const select = getByLabelText('Bedroom fan mode') as HTMLSelectElement;
		expect(select.value).toBe('auto');
		fireEvent.change(select, { target: { value: 'high' } });
		expect(detail).toEqual({
			domain: 'climate',
			service: 'set_fan_mode',
			data: { fan_mode: 'high' }
		});
	});

	it('offers a "fan…" placeholder when no fan mode is reported', () => {
		const climate = {
			state: 'cool',
			attributes: { friendly_name: 'Bedroom', fan_modes: ['auto', 'low'] }
		};
		const { getByLabelText, getByText } = render(
			<HaClimate value={climate} onControl={() => undefined} />
		);
		const select = getByLabelText('Bedroom fan mode') as HTMLSelectElement;
		expect(select.value).toBe('');
		expect(getByText('fan…').tagName).toBe('OPTION');
	});

	it('keeps an unlisted reported fan mode selectable', () => {
		const climate = {
			state: 'cool',
			attributes: { friendly_name: 'Bedroom', fan_modes: ['low', 'high'], fan_mode: 'turbo' }
		};
		const { getByLabelText, getByText } = render(
			<HaClimate value={climate} onControl={() => undefined} />
		);
		const select = getByLabelText('Bedroom fan mode') as HTMLSelectElement;
		expect(select.value).toBe('turbo');
		// The reported-but-unlisted mode is added as its own option so the value stays matched.
		expect(getByText('turbo').tagName).toBe('OPTION');
	});

	it('falls back to placeholders and defaults when value is null', () => {
		const { getByText, getAllByText } = render(<HaClimate value={null} />);
		// label ?? friendly_name ?? 'Climate'; state ?? '—'; current/target → '—'.
		expect(() => getByText('Climate')).not.toThrow();
		expect(getAllByText('—').length).toBeGreaterThan(0);
		expect(() => getByText(/—\s*→\s*—/)).not.toThrow();
	});

	it('renders read-only (no controls) without an onControl handler', () => {
		const climate = {
			state: 'cool',
			attributes: {
				friendly_name: 'Bedroom',
				temperature: 21,
				hvac_modes: ['off', 'cool', 'heat'],
				fan_modes: ['auto', 'low']
			}
		};
		const { queryByLabelText } = render(<HaClimate value={climate} />);
		expect(queryByLabelText('Bedroom mode (tap to change)')).toBeNull();
		expect(queryByLabelText('Raise Bedroom setpoint')).toBeNull();
		expect(queryByLabelText('Bedroom fan mode')).toBeNull();
	});
});
