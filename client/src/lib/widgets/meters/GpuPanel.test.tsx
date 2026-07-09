import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import GpuPanel from './GpuPanel';
import type { SensorState } from '../../core/telemetry';

afterEach(cleanup);
const scalar = (v: number): SensorState => ({ value: { kind: 'scalar', value: v }, history: [] });
const txt = (v: string): SensorState => ({ value: { kind: 'text', value: v }, history: [] });

describe('GpuPanel meter', () => {
	it('shows the name, util %, and the reported secondary stats', () => {
		const { container } = render(
			<GpuPanel
				sensors={{
					name: txt('NVIDIA RTX 4080'),
					util: scalar(43),
					temp: scalar(61),
					vramUsed: scalar(6_000_000_000),
					vramTotal: scalar(12_000_000_000),
					power: scalar(150),
					clock: scalar(1950)
				}}
			/>
		);
		expect(container.querySelector('.gpu-name')?.textContent).toBe('NVIDIA RTX 4080');
		expect(container.querySelector('.gpu-util-val')?.textContent).toBe('43%');
		const labels = [...container.querySelectorAll('.gpu-stat-label')].map((e) => e.textContent);
		expect(labels).toEqual(['temp', 'vram', 'power', 'clock']); // fan absent → dropped
	});

	it('falls back to "GPU" / "—" and no stats grid when nothing is reported', () => {
		const { container } = render(<GpuPanel sensors={{}} />);
		expect(container.querySelector('.gpu-name')?.textContent).toBe('GPU');
		expect(container.querySelector('.gpu-util-val')?.textContent).toBe('—');
		expect(container.querySelector('.gpu-stats')).toBeNull();
	});

	it('applies a per-instance color as the --gpu-accent CSS variable', () => {
		const { container } = render(<GpuPanel sensors={{}} color="rgb(7,7,7)" />);
		const root = container.querySelector('.np-gpu') as HTMLElement;
		expect(root.style.getPropertyValue('--gpu-accent')).toBe('rgb(7,7,7)');
	});

	it('hides the name row when showName is off', () => {
		const { container } = render(
			<GpuPanel sensors={{ name: txt('NVIDIA RTX 4080') }} showName={false} />
		);
		expect(container.querySelector('.gpu-name')).toBeNull();
	});
});
