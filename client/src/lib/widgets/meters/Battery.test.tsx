import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import Battery from './Battery';
import type { SensorState } from '../../core/telemetry';

afterEach(cleanup);
const scalar = (v: number): SensorState => ({ value: { kind: 'scalar', value: v }, history: [] });
const txt = (v: string): SensorState => ({ value: { kind: 'text', value: v }, history: [] });

describe('Battery meter', () => {
	it('shows percent + the discharging time-left', () => {
		const { container } = render(
			<Battery sensors={{ percent: scalar(72), state: txt('discharging'), time: scalar(8100) }} />
		);
		expect(container.querySelector('.bat-pct')?.textContent).toBe('72%');
		expect(container.querySelector('.bat-status')?.textContent).toBe('2h 15m left');
		expect(container.querySelector('.battery')?.getAttribute('data-level')).toBe('ok');
	});

	it('flags charging (and stays "ok" even at a low charge)', () => {
		const { container } = render(
			<Battery sensors={{ percent: scalar(8), state: txt('charging') }} />
		);
		expect(container.querySelector('.battery')?.getAttribute('data-charging')).toBe('true');
		expect(container.querySelector('.battery')?.getAttribute('data-level')).toBe('ok');
		expect(container.querySelector('.bat-status')?.textContent).toBe('Charging');
	});

	it('marks a low discharge critical and renders a dash with no data', () => {
		const { container } = render(
			<Battery sensors={{ percent: scalar(7), state: txt('discharging') }} />
		);
		expect(container.querySelector('.battery')?.getAttribute('data-level')).toBe('critical');
		cleanup();
		const { container: empty } = render(<Battery sensors={{}} />);
		expect(empty.querySelector('.bat-pct')?.textContent).toBe('—');
	});

	it('applies a per-instance color as the --bat-accent CSS variable', () => {
		const { container } = render(<Battery sensors={{}} color="rgb(6,6,6)" />);
		const root = container.querySelector('.np-battery') as HTMLElement;
		expect(root.style.getPropertyValue('--bat-accent')).toBe('rgb(6,6,6)');
	});
});
