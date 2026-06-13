import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import Weather from './Weather';
import type { SensorState } from '../../core/telemetry';

afterEach(cleanup);
const scalar = (v: number): SensorState => ({ value: { kind: 'scalar', value: v }, history: [] });
const txt = (v: string): SensorState => ({ value: { kind: 'text', value: v }, history: [] });

describe('Weather meter', () => {
	it('shows temperature (with unit), condition, high/low, and detail', () => {
		const { container } = render(
			<Weather
				sensors={{
					temp: scalar(12),
					code: scalar(3), // overcast
					is_day: scalar(1),
					high: scalar(15),
					low: scalar(8),
					humidity: scalar(80),
					wind: scalar(14),
					apparent: scalar(10),
					unit: txt('C')
				}}
			/>
		);
		expect(container.querySelector('.wx-temp-val')?.textContent).toBe('12°C');
		expect(container.querySelector('.wx-cond')?.textContent).toBe('Overcast');
		expect(container.querySelector('.wx-hi')?.textContent).toBe('↑ 15°');
		expect(container.querySelector('.wx-lo')?.textContent).toBe('↓ 8°');
		expect(container.querySelector('.wx-detail')?.textContent).toContain('14 km/h');
		expect(container.querySelector('.wx-detail')?.textContent).toContain('feels 10°');
	});

	it('uses mph for fahrenheit and the night glyph', () => {
		const { container } = render(
			<Weather
				sensors={{
					temp: scalar(70),
					code: scalar(0),
					is_day: scalar(0),
					wind: scalar(9),
					unit: txt('F')
				}}
			/>
		);
		expect(container.querySelector('.wx-temp-val')?.textContent).toBe('70°F');
		expect(container.querySelector('.wx-icon')?.textContent).toBe('🌙'); // clear, night
		expect(container.querySelector('.wx-detail')?.textContent).toContain('9 mph');
	});

	it('renders dashes with no data', () => {
		const { container } = render(<Weather sensors={{}} />);
		expect(container.querySelector('.wx-temp-val')?.textContent).toBe('—');
		expect(container.querySelector('.wx-cond')?.textContent).toBe('—');
	});
});
