import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import AirQuality from './AirQuality';
import type { SensorState } from '../../core/telemetry';

afterEach(cleanup);
const sc = (v: number): SensorState => ({ value: { kind: 'scalar', value: v }, history: [] });

describe('AirQuality meter', () => {
	it('shows the AQI value, band, and detail', () => {
		const { container } = render(
			<AirQuality sensors={{ aqi: sc(34), pm25: sc(8.2), uv: sc(6) }} />
		);
		expect(container.querySelector('.aq-value')?.textContent).toBe('34');
		expect(container.querySelector('.aq-band')?.textContent).toBe('Fair');
		expect(container.querySelector('.airquality')?.getAttribute('data-level')).toBe('fair');
		const detail = container.querySelector('.aq-detail')?.textContent ?? '';
		expect(detail).toContain('PM2.5 8.2');
		expect(detail).toContain('UV 6 · High');
	});

	it('colours the band by severity', () => {
		const { container } = render(<AirQuality sensors={{ aqi: sc(95) }} />);
		expect(container.querySelector('.airquality')?.getAttribute('data-level')).toBe('verypoor');
		expect(container.querySelector('.aq-band')?.textContent).toBe('Very poor');
	});

	it('dashes with no data', () => {
		const { container } = render(<AirQuality sensors={{}} />);
		expect(container.querySelector('.aq-value')?.textContent).toBe('—');
	});

	it('applies a per-instance color as the --aq-accent CSS variable', () => {
		const { container } = render(<AirQuality sensors={{}} color="rgb(8,8,8)" />);
		const root = container.querySelector('.np-airquality') as HTMLElement;
		expect(root.style.getPropertyValue('--aq-accent')).toBe('rgb(8,8,8)');
	});

	it('hides the detail row entirely when both PM2.5 and UV are disabled', () => {
		const { container } = render(
			<AirQuality
				sensors={{ aqi: sc(34), pm25: sc(8.2), uv: sc(6) }}
				showPm={false}
				showUv={false}
			/>
		);
		expect(container.querySelector('.aq-detail')).toBeNull();
	});

	it('omits just the PM2.5 or UV line when that toggle is off, keeping the other', () => {
		const { container } = render(
			<AirQuality sensors={{ aqi: sc(34), pm25: sc(8.2), uv: sc(6) }} showPm={false} />
		);
		const detail = container.querySelector('.aq-detail')?.textContent ?? '';
		expect(detail).not.toContain('PM2.5');
		expect(detail).toContain('UV');
	});
});
