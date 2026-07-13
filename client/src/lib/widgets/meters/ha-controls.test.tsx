import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import HaSwitch from './HaSwitch';
import HaScene from './HaScene';
import HaFan from './HaFan';
import HaCover from './HaCover';
import HaLock from './HaLock';
import HaBinarySensor from './HaBinarySensor';
import HaInput from './HaInput';
import HaClimate from './HaClimate';
import HaLight from './HaLight';
import HaMediaPlayer from './HaMediaPlayer';

describe('HaSwitch', () => {
	it('shows ON/OFF and toggles', () => {
		let detail: unknown = null;
		const { getByText, getByRole } = render(
			<HaSwitch
				value={{ state: 'on', attributes: { friendly_name: 'Plug' } }}
				onControl={(e) => (detail = e)}
			/>
		);
		expect(() => getByText('ON')).not.toThrow();
		fireEvent.click(getByRole('button'));
		expect(detail).toEqual({ domain: 'switch', service: 'toggle' });
	});
});

describe('HaScene', () => {
	it('activates the scene on click', () => {
		let detail: unknown = null;
		const { getByRole } = render(
			<HaScene value={{ attributes: { friendly_name: 'Movie' } }} onControl={(e) => (detail = e)} />
		);
		fireEvent.click(getByRole('button'));
		expect(detail).toEqual({ domain: 'scene', service: 'turn_on' });
	});
});

describe('HaFan', () => {
	it('toggles when off (no speed / oscillate controls)', () => {
		let detail: unknown = null;
		const { getByRole, queryByRole } = render(
			<HaFan
				value={{ state: 'off', attributes: { friendly_name: 'Fan' } }}
				onControl={(e) => (detail = e)}
			/>
		);
		expect(queryByRole('slider')).toBeNull();
		fireEvent.click(getByRole('button'));
		expect(detail).toEqual({ domain: 'fan', service: 'toggle' });
	});

	it('emits set_percentage from the speed slider', () => {
		let detail: unknown = null;
		const { getByRole } = render(
			<HaFan
				value={{ state: 'on', attributes: { friendly_name: 'Fan', percentage: 50 } }}
				onControl={(e) => (detail = e)}
			/>
		);
		fireEvent.change(getByRole('slider'), { target: { value: '80' } });
		expect(detail).toEqual({ domain: 'fan', service: 'set_percentage', data: { percentage: 80 } });
	});

	it('emits oscillate, and hides the speed slider when showSpeed=false', () => {
		let detail: unknown = null;
		const { getByLabelText, queryByRole } = render(
			<HaFan
				value={{
					state: 'on',
					attributes: { friendly_name: 'Fan', percentage: 50, oscillating: false }
				}}
				showSpeed={false}
				onControl={(e) => (detail = e)}
			/>
		);
		expect(queryByRole('slider')).toBeNull();
		fireEvent.click(getByLabelText('Fan oscillate'));
		expect(detail).toEqual({ domain: 'fan', service: 'oscillate', data: { oscillating: true } });
	});
});

describe('HaCover', () => {
	const cover = { state: 'open', attributes: { friendly_name: 'Blind', current_position: 60 } };

	it('emits open/stop/close + set_cover_position', () => {
		let detail: unknown = null;
		const { getByLabelText, getByRole } = render(
			<HaCover value={cover} onControl={(e) => (detail = e)} />
		);
		fireEvent.click(getByLabelText('Open Blind'));
		expect(detail).toEqual({ domain: 'cover', service: 'open_cover' });
		fireEvent.click(getByLabelText('Stop Blind'));
		expect(detail).toEqual({ domain: 'cover', service: 'stop_cover' });
		fireEvent.click(getByLabelText('Close Blind'));
		expect(detail).toEqual({ domain: 'cover', service: 'close_cover' });
		fireEvent.change(getByRole('slider'), { target: { value: '30' } });
		expect(detail).toEqual({
			domain: 'cover',
			service: 'set_cover_position',
			data: { position: 30 }
		});
	});

	it('respects showButtons / showPosition toggles', () => {
		const { queryByLabelText, queryByRole } = render(
			<HaCover value={cover} showButtons={false} showPosition={false} onControl={() => undefined} />
		);
		expect(queryByLabelText('Open Blind')).toBeNull();
		expect(queryByRole('slider')).toBeNull();
	});
});

describe('HaLock', () => {
	it('locks when unlocked', () => {
		let detail: unknown = null;
		const { getByRole } = render(
			<HaLock
				value={{ state: 'unlocked', attributes: { friendly_name: 'Door' } }}
				onControl={(e) => (detail = e)}
			/>
		);
		fireEvent.click(getByRole('button'));
		expect(detail).toEqual({ domain: 'lock', service: 'lock' });
	});

	it('unlocks when locked', () => {
		let detail: unknown = null;
		const { getByRole } = render(
			<HaLock
				value={{ state: 'locked', attributes: { friendly_name: 'Door' } }}
				onControl={(e) => (detail = e)}
			/>
		);
		fireEvent.click(getByRole('button'));
		expect(detail).toEqual({ domain: 'lock', service: 'unlock' });
	});
});

describe('HaBinarySensor', () => {
	it('maps device_class on/off to semantic words', () => {
		const door = render(
			<HaBinarySensor
				value={{ state: 'on', attributes: { friendly_name: 'Front', device_class: 'door' } }}
			/>
		);
		expect(() => door.getByText('Open')).not.toThrow();
	});

	it('falls back to ON/OFF without a device_class', () => {
		const { getByText } = render(
			<HaBinarySensor value={{ state: 'off', attributes: { friendly_name: 'X' } }} />
		);
		expect(() => getByText('OFF')).not.toThrow();
	});
});

describe('HaInput', () => {
	it('input_boolean → toggle', () => {
		let detail: unknown = null;
		const { getByRole } = render(
			<HaInput
				value={{ entity_id: 'input_boolean.x', state: 'off', attributes: {} }}
				onControl={(e) => (detail = e)}
			/>
		);
		fireEvent.click(getByRole('button'));
		expect(detail).toEqual({ domain: 'input_boolean', service: 'toggle' });
	});

	it('input_button → press', () => {
		let detail: unknown = null;
		const { getByRole } = render(
			<HaInput
				value={{ entity_id: 'input_button.x', state: '', attributes: {} }}
				onControl={(e) => (detail = e)}
			/>
		);
		fireEvent.click(getByRole('button'));
		expect(detail).toEqual({ domain: 'input_button', service: 'press' });
	});

	it('input_select → select_option', () => {
		let detail: unknown = null;
		const { getByRole } = render(
			<HaInput
				value={{ entity_id: 'input_select.x', state: 'A', attributes: { options: ['A', 'B'] } }}
				onControl={(e) => (detail = e)}
			/>
		);
		fireEvent.change(getByRole('combobox'), { target: { value: 'B' } });
		expect(detail).toEqual({
			domain: 'input_select',
			service: 'select_option',
			data: { option: 'B' }
		});
	});

	it('input_number → set_value, clamped to min/max', () => {
		let detail: unknown = null;
		const { getByRole } = render(
			<HaInput
				value={{
					entity_id: 'input_number.x',
					state: '5',
					attributes: { min: 0, max: 10, step: 1 }
				}}
				onControl={(e) => (detail = e)}
			/>
		);
		fireEvent.change(getByRole('slider'), { target: { value: '8' } });
		expect(detail).toEqual({ domain: 'input_number', service: 'set_value', data: { value: 8 } });
	});
});

describe('HaClimate (A/C controls)', () => {
	const ac = {
		state: 'cool',
		attributes: {
			friendly_name: 'AC',
			current_temperature: 26,
			temperature: 23,
			hvac_modes: ['off', 'cool', 'heat'],
			fan_modes: ['auto', 'low', 'high'],
			fan_mode: 'auto',
			min_temp: 16,
			max_temp: 30,
			target_temp_step: 1
		}
	};

	it('cycles HVAC mode on tap', () => {
		let detail: unknown = null;
		const { getByLabelText } = render(<HaClimate value={ac} onControl={(e) => (detail = e)} />);
		fireEvent.click(getByLabelText(/AC mode/i));
		expect(detail).toEqual({
			domain: 'climate',
			service: 'set_hvac_mode',
			data: { hvac_mode: 'heat' }
		});
	});

	it('sets fan mode from the selector', () => {
		let detail: unknown = null;
		const { getByLabelText } = render(<HaClimate value={ac} onControl={(e) => (detail = e)} />);
		fireEvent.change(getByLabelText('AC fan mode'), { target: { value: 'high' } });
		expect(detail).toEqual({
			domain: 'climate',
			service: 'set_fan_mode',
			data: { fan_mode: 'high' }
		});
	});

	it('show* toggles hide the mode button / fan select / temp buttons', () => {
		const { queryByLabelText } = render(
			<HaClimate
				value={ac}
				showMode={false}
				showFan={false}
				showTemp={false}
				onControl={() => undefined}
			/>
		);
		expect(queryByLabelText(/AC mode/i)).toBeNull();
		expect(queryByLabelText('AC fan mode')).toBeNull();
		expect(queryByLabelText('Raise AC setpoint')).toBeNull();
	});
});

describe('HaLight showBrightness gate', () => {
	it('hides the slider for a dimmable light when showBrightness=false', () => {
		const dimmable = {
			state: 'on',
			attributes: {
				friendly_name: 'Kitchen',
				supported_color_modes: ['brightness'],
				brightness: 128
			}
		};
		const { queryByRole } = render(<HaLight value={dimmable} showBrightness={false} />);
		expect(queryByRole('slider')).toBeNull();
	});
});

describe('HaMediaPlayer', () => {
	const playing = {
		state: 'playing',
		attributes: {
			friendly_name: 'Speaker',
			media_title: 'Song',
			media_artist: 'Artist',
			volume_level: 0.5,
			is_volume_muted: false
		}
	};

	it('shows now-playing text and emits transport + volume', () => {
		let detail: unknown = null;
		const { getByText, getByLabelText, getByRole } = render(
			<HaMediaPlayer value={playing} onControl={(e) => (detail = e)} />
		);
		expect(() => getByText(/Song · Artist/)).not.toThrow();

		fireEvent.click(getByLabelText('Previous on Speaker'));
		expect(detail).toEqual({ domain: 'media_player', service: 'media_previous_track' });
		fireEvent.click(getByLabelText('Pause Speaker'));
		expect(detail).toEqual({ domain: 'media_player', service: 'media_play_pause' });
		fireEvent.click(getByLabelText('Next on Speaker'));
		expect(detail).toEqual({ domain: 'media_player', service: 'media_next_track' });
		fireEvent.change(getByRole('slider'), { target: { value: '80' } });
		expect(detail).toEqual({
			domain: 'media_player',
			service: 'volume_set',
			data: { volume_level: 0.8 }
		});
		fireEvent.click(getByLabelText('Mute Speaker'));
		expect(detail).toEqual({
			domain: 'media_player',
			service: 'volume_mute',
			data: { is_volume_muted: true }
		});
	});

	it('hides transport when off, and respects show* toggles', () => {
		const off = render(
			<HaMediaPlayer value={{ state: 'off', attributes: { friendly_name: 'Speaker' } }} />
		);
		expect(off.queryByLabelText(/Play|Pause/)).toBeNull();

		const gated = render(
			<HaMediaPlayer value={playing} showTransport={false} showVolume={false} />
		);
		expect(gated.queryByLabelText('Next on Speaker')).toBeNull();
		expect(gated.queryByRole('slider')).toBeNull();
	});

	it('renders album art when an art URL is provided', () => {
		const { container } = render(<HaMediaPlayer value={playing} art="http://art.localhost/123" />);
		const img = container.querySelector('img.art');
		expect(img?.getAttribute('src')).toBe('http://art.localhost/123');
	});
});

// Branch/fallback coverage: null value (default prop), missing friendly_name → the per-widget
// default label, and the off/alternate state arms. These render-only paths don't need handlers.
describe('HA control fallbacks (null value, default names, off/alt states)', () => {
	it('HaSwitch: null value → OFF + "Switch" default, no className "on", click is a no-op without onControl', () => {
		const { getByRole, getByText } = render(<HaSwitch />);
		const btn = getByRole('button');
		expect(getByText('Switch')).toBeTruthy();
		expect(getByText('OFF')).toBeTruthy();
		expect(btn.getAttribute('aria-pressed')).toBe('false');
		expect(btn.className).not.toContain(' on');
		// onControl is optional — clicking without it must not throw.
		expect(() => fireEvent.click(btn)).not.toThrow();
	});

	it('HaScene: null value → "Scene" default; click without onControl is a no-op', () => {
		const { getByRole, getByText } = render(<HaScene />);
		expect(getByText('Scene')).toBeTruthy();
		expect(() => fireEvent.click(getByRole('button'))).not.toThrow();
	});

	it('HaLock: null value → "Lock" + "—" state, not locked; click without onControl is a no-op', () => {
		const { getByRole, getByText } = render(<HaLock />);
		const btn = getByRole('button');
		expect(getByText('Lock')).toBeTruthy();
		expect(getByText('—')).toBeTruthy();
		expect(btn.getAttribute('aria-pressed')).toBe('false');
		expect(btn.className).not.toContain('locked');
		expect(() => fireEvent.click(btn)).not.toThrow();
	});

	it('HaFan: null value → "Fan" + OFF, no slider/oscillate; toggle is a no-op without onControl', () => {
		const { getByText, queryByRole, queryByLabelText } = render(<HaFan />);
		expect(getByText('Fan')).toBeTruthy();
		expect(getByText('OFF')).toBeTruthy();
		expect(queryByRole('slider')).toBeNull();
		expect(queryByLabelText('Fan oscillate')).toBeNull();
		expect(() => fireEvent.click(getByText('Fan'))).not.toThrow();
	});

	it('HaFan: oscillating=true marks the oscillate button on', () => {
		const { getByLabelText } = render(
			<HaFan value={{ state: 'on', attributes: { friendly_name: 'Fan', oscillating: true } }} />
		);
		const osc = getByLabelText('Fan oscillate');
		expect(osc.className).toContain('on');
		expect(osc.getAttribute('aria-pressed')).toBe('true');
	});

	it('HaFan: on but no percentage → ON (no speed slider)', () => {
		const { getByText, queryByRole } = render(
			<HaFan value={{ state: 'on', attributes: { friendly_name: 'Fan' } }} />
		);
		expect(getByText('ON')).toBeTruthy();
		expect(queryByRole('slider')).toBeNull();
	});

	it('HaCover: null value → "Cover" + "—" state; controls are no-ops without onControl', () => {
		const { getByText, getByLabelText } = render(<HaCover />);
		expect(getByText('Cover')).toBeTruthy();
		expect(getByText('—')).toBeTruthy();
		// Buttons render (showButtons defaults true) but have no position slider (no current_position).
		expect(() => fireEvent.click(getByLabelText('Open Cover'))).not.toThrow();
	});

	it('HaCover: no-op setPos when onControl is absent', () => {
		const { getByRole } = render(
			<HaCover
				value={{ state: 'open', attributes: { friendly_name: 'Blind', current_position: 60 } }}
			/>
		);
		expect(() => fireEvent.change(getByRole('slider'), { target: { value: '30' } })).not.toThrow();
	});

	it('HaLight: null value → "Light" + OFF; toggle is a no-op without onControl', () => {
		const { getByText } = render(<HaLight />);
		expect(getByText('Light')).toBeTruthy();
		expect(getByText('OFF')).toBeTruthy();
		expect(() => fireEvent.click(getByText('Light'))).not.toThrow();
	});

	it('HaBinarySensor: null value → "—" name and "—" value', () => {
		const { getAllByText } = render(<HaBinarySensor />);
		expect(getAllByText('—').length).toBeGreaterThanOrEqual(2);
	});

	it('HaBinarySensor: device_class off → the off-word (words[1])', () => {
		const { getByText } = render(
			<HaBinarySensor
				value={{ state: 'off', attributes: { friendly_name: 'Front', device_class: 'door' } }}
			/>
		);
		expect(getByText('Closed')).toBeTruthy();
	});

	it('HaBinarySensor: an unknown state (neither on nor off) renders verbatim', () => {
		const { getByText } = render(
			<HaBinarySensor value={{ state: 'unavailable', attributes: { friendly_name: 'Front' } }} />
		);
		expect(getByText('unavailable')).toBeTruthy();
	});

	it('HaMediaPlayer: null value → "Media"; the "—" state is treated as active so transport shows', () => {
		const { getByText, queryByLabelText } = render(<HaMediaPlayer />);
		expect(getByText('Media')).toBeTruthy();
		// state defaults to '—', which is NOT in the off/unavailable/standby exclusion list → active,
		// so with no media_title the now-playing line shows the raw state and transport renders.
		expect(getByText('—')).toBeTruthy();
		expect(queryByLabelText(/Play|Pause/)).toBeTruthy();
	});

	it('HaMediaPlayer: an inactive state with no title shows "idle" and hides transport', () => {
		const { getByText, queryByLabelText } = render(
			<HaMediaPlayer value={{ state: 'off', attributes: { friendly_name: 'Speaker' } }} />
		);
		expect(getByText('idle')).toBeTruthy();
		expect(queryByLabelText(/Play|Pause/)).toBeNull();
	});

	it('HaMediaPlayer: paused shows the play (▶) glyph and falls back through artist sources', () => {
		const { getByLabelText, getByText } = render(
			<HaMediaPlayer
				value={{
					state: 'paused',
					attributes: { friendly_name: 'Speaker', media_title: 'Show', media_series_title: 'S1' }
				}}
			/>
		);
		// state==='paused' (active, not playing) → Play label + ▶ icon.
		const playBtn = getByLabelText('Play Speaker');
		expect(playBtn.textContent).toBe('▶');
		expect(getByText(/Show · S1/)).toBeTruthy();
	});

	it('HaMediaPlayer: artist falls back to app_name when title/series/artist absent', () => {
		const { getByText } = render(
			<HaMediaPlayer
				value={{ state: 'playing', attributes: { friendly_name: 'Speaker', app_name: 'Spotify' } }}
			/>
		);
		// No media_title → shows the active state ('playing') then " · Spotify".
		expect(getByText(/playing · Spotify/)).toBeTruthy();
	});

	it('HaMediaPlayer: muted shows 🔇 + "on" class; transport/volume are no-ops without onControl', () => {
		const { getByLabelText, getByRole } = render(
			<HaMediaPlayer
				value={{
					state: 'playing',
					attributes: { friendly_name: 'Speaker', volume_level: 0.4, is_volume_muted: true }
				}}
			/>
		);
		const mute = getByLabelText('Unmute Speaker');
		expect(mute.textContent).toBe('🔇');
		expect(mute.className).toContain('on');
		expect(mute.getAttribute('aria-pressed')).toBe('true');
		// No onControl → clicks/changes must not throw.
		expect(() => fireEvent.click(getByLabelText('Next on Speaker'))).not.toThrow();
		expect(() => fireEvent.change(getByRole('slider'), { target: { value: '70' } })).not.toThrow();
	});
});
