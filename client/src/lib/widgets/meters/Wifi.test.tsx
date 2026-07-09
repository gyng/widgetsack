import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import Wifi from './Wifi';
import type { SensorState } from '../../core/telemetry';

afterEach(cleanup);
const sc = (v: number): SensorState => ({ value: { kind: 'scalar', value: v }, history: [] });
const tx = (v: string): SensorState => ({ value: { kind: 'text', value: v }, history: [] });

describe('Wifi meter', () => {
	it('shows the SSID, signal bars, and the detail line', () => {
		const { container } = render(
			<Wifi
				sensors={{
					ssid: tx('HomeNet'),
					signal: sc(82),
					rssi: sc(-59),
					rx: sc(866),
					band: tx('5 GHz'),
					channel: sc(36),
					phy: tx('ac')
				}}
			/>
		);
		expect(container.querySelector('.wf-ssid')?.textContent).toBe('HomeNet');
		expect(container.querySelector('.wifi')?.getAttribute('data-level')).toBe('strong');
		expect(container.querySelectorAll('.wf-bar[data-on]')).toHaveLength(4);
		const detail = container.querySelector('.wf-detail')?.textContent ?? '';
		expect(detail).toContain('5 GHz');
		expect(detail).toContain('ch 36');
		expect(detail).toContain('802.11ac');
		expect(detail).toContain('-59 dBm');
		expect(detail).toContain('866 Mbps');
	});

	it('shows "Not connected" with no SSID and hides detail', () => {
		const { container } = render(<Wifi sensors={{}} />);
		expect(container.querySelector('.wf-ssid')?.textContent).toBe('Not connected');
		expect(container.querySelector('.wf-detail')).toBeNull();
		expect(container.querySelectorAll('.wf-bar[data-on]')).toHaveLength(0);
	});

	it('tints weak signal', () => {
		const { container } = render(<Wifi sensors={{ ssid: tx('Far'), signal: sc(15) }} />);
		expect(container.querySelector('.wifi')?.getAttribute('data-level')).toBe('weak');
		expect(container.querySelectorAll('.wf-bar[data-on]')).toHaveLength(1);
	});

	it('applies a per-instance color as the --wf-accent CSS variable', () => {
		const { container } = render(<Wifi sensors={{}} color="rgb(5,5,5)" />);
		const root = container.querySelector('.np-wifi') as HTMLElement;
		expect(root.style.getPropertyValue('--wf-accent')).toBe('rgb(5,5,5)');
	});
});
