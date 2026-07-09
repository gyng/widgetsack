import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import ProcessWatch from './ProcessWatch';
import type { SensorState } from '../../core/telemetry';

afterEach(cleanup);
const sc = (v: number): SensorState => ({ value: { kind: 'scalar', value: v }, history: [] });

describe('ProcessWatch meter', () => {
	it('shows running with CPU% + RAM (+count when >1)', () => {
		const { container } = render(
			<ProcessWatch
				name="chrome.exe"
				sensors={{ running: sc(1), cpu: sc(18.4), mem: sc(2_000_000_000), count: sc(7) }}
			/>
		);
		expect(container.querySelector('.procwatch')?.getAttribute('data-state')).toBe('running');
		expect(container.querySelector('.pw-name')?.textContent).toBe('chrome.exe');
		const status = container.querySelector('.pw-status')?.textContent ?? '';
		expect(status).toContain('18.4%');
		expect(status).toContain('×7');
	});

	it('shows "not running" when stopped', () => {
		const { container } = render(<ProcessWatch sensors={{ running: sc(0), count: sc(0) }} />);
		expect(container.querySelector('.procwatch')?.getAttribute('data-state')).toBe('stopped');
		expect(container.querySelector('.pw-status')?.textContent).toBe('not running');
	});

	it('is unknown (dash) before the first sample', () => {
		const { container } = render(<ProcessWatch sensors={{}} />);
		expect(container.querySelector('.procwatch')?.getAttribute('data-state')).toBe('unknown');
		expect(container.querySelector('.pw-status')?.textContent).toBe('—');
	});

	it('falls back to a bare "running" when no cpu/mem/count sample has arrived yet', () => {
		const { container } = render(<ProcessWatch sensors={{ running: sc(1) }} />);
		expect(container.querySelector('.pw-status')?.textContent).toBe('running');
	});

	it('omits the ×count suffix when the count is 1', () => {
		const { container } = render(
			<ProcessWatch sensors={{ running: sc(1), cpu: sc(2), mem: sc(1024), count: sc(1) }} />
		);
		const status = container.querySelector('.pw-status')?.textContent ?? '';
		expect(status).not.toContain('×');
	});

	it('applies a per-instance color as the --pw-accent CSS variable', () => {
		const { container } = render(<ProcessWatch sensors={{}} color="rgb(9,8,7)" />);
		const root = container.querySelector('.np-procwatch') as HTMLElement;
		expect(root.style.getPropertyValue('--pw-accent')).toBe('rgb(9,8,7)');
	});

	it('prefers a custom label over the raw process name', () => {
		const { container } = render(<ProcessWatch name="chrome.exe" label="Browser" sensors={{}} />);
		expect(container.querySelector('.pw-name')?.textContent).toBe('Browser');
	});
});
