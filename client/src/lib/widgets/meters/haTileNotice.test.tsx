import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { ComponentType } from 'react';
import HaSensor from './HaSensor';
import HaBinarySensor from './HaBinarySensor';
import HaSwitch from './HaSwitch';
import HaScene from './HaScene';
import HaLight from './HaLight';
import HaFan from './HaFan';
import HaCover from './HaCover';
import HaLock from './HaLock';
import HaMediaPlayer from './HaMediaPlayer';
import HaInput from './HaInput';
import HaClimate from './HaClimate';
import { HA_UNCONFIGURED_MESSAGE } from '../../core/haTileState';

// Every HA tile takes the host-supplied `haStatus` and, when there's no live data, renders the
// shared notice (HaTileNotice) in place of its value — keeping its own root class so themes still
// match. The state → message mapping itself is core/haTileState (unit-tested); here we prove each
// meter is wired to it and that a wired-but-healthy tile still renders its real value.
type Tile = ComponentType<{ value?: unknown; haStatus?: string | null; label?: string }>;

const TILES: [string, Tile, string][] = [
	['HaSensor', HaSensor, 'np-ha-sensor'],
	['HaBinarySensor', HaBinarySensor, 'np-ha-binary'],
	['HaSwitch', HaSwitch, 'np-ha-switch'],
	['HaScene', HaScene, 'np-ha-scene'],
	['HaLight', HaLight, 'np-ha-light'],
	['HaFan', HaFan, 'np-ha-fan'],
	['HaCover', HaCover, 'np-ha-cover'],
	['HaLock', HaLock, 'np-ha-lock'],
	['HaMediaPlayer', HaMediaPlayer, 'np-ha-media'],
	['HaInput', HaInput, 'np-ha-input'],
	['HaClimate', HaClimate, 'np-ha-climate']
];

describe('HA tiles — no-data states', () => {
	it.each(TILES)(
		'%s: on the unconfigured status it says so (keeps its root class); no status → waits',
		(_name, Tile, rootClass) => {
			const { container, getByRole, rerender } = render(
				<Tile haStatus="unconfigured" label="Lounge" />
			);
			const notice = getByRole('status');
			expect(notice.textContent).toBe(HA_UNCONFIGURED_MESSAGE);
			const root = container.firstElementChild as HTMLElement;
			expect(root.classList.contains(rootClass)).toBe(true);
			expect(root.getAttribute('data-tile-state')).toBe('unconfigured');
			// The label survives so the user knows WHICH tile is unconfigured.
			expect(root.textContent).toContain('Lounge');
			// Nothing interactive is offered while there's nothing to control.
			expect(container.querySelector('button')).toBeNull();
			// No status sample heard yet is NOT "not configured" — a late-mounted window waits.
			rerender(<Tile haStatus={null} label="Lounge" />);
			expect(getByRole('status').textContent).toBe('Waiting for Home Assistant…');
			expect(root.getAttribute('data-tile-state')).toBe('waiting');
		}
	);

	it('distinguishes offline from an unavailable entity', () => {
		const { getByRole, rerender } = render(<HaSensor haStatus="connecting" value={null} />);
		expect(getByRole('status').textContent).toBe('Connecting to Home Assistant…');
		rerender(<HaSensor haStatus="error" value={{ state: '21' }} />);
		expect(getByRole('status').textContent).toBe('Home Assistant offline');
		rerender(<HaSensor haStatus="connected" value={{ state: 'unavailable' }} />);
		expect(getByRole('status').textContent).toBe('Entity unavailable');
		rerender(<HaSensor haStatus="connected" value={null} />);
		expect(getByRole('status').textContent).toBe('Waiting for the entity…');
	});

	it('renders the real value once connected with a live entity', () => {
		const { queryByRole, getByText } = render(
			<HaSensor
				haStatus="connected"
				value={{ state: '21.4', attributes: { unit_of_measurement: '°C' } }}
			/>
		);
		expect(queryByRole('status')).toBeNull();
		expect(getByText(/21\.4\s*°C/)).toBeTruthy();
	});
});
