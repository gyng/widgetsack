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

	it('renders a forecast column per day from the day.N sensors', () => {
		const { container } = render(
			<Weather
				forecastDays={3}
				sensors={{
					temp: scalar(12),
					code: scalar(3),
					unit: txt('C'),
					d0high: scalar(15),
					d0low: scalar(8),
					d0code: scalar(0),
					d1high: scalar(17),
					d1low: scalar(9),
					d1code: scalar(61),
					d2high: scalar(12),
					d2low: scalar(5),
					d2code: scalar(2)
				}}
			/>
		);
		const cols = container.querySelectorAll('.wx-day');
		expect(cols).toHaveLength(3);
		expect(cols[0].querySelector('.wx-day-label')?.textContent).toBe('Today');
		expect(cols[0].querySelector('.wx-day-hi')?.textContent).toBe('15°');
		expect(cols[0].querySelector('.wx-day-icon')?.textContent).toBe('☀️'); // code 0 = clear (day)
	});

	it('omits the forecast strip when forecastDays is 0 (default)', () => {
		const { container } = render(<Weather sensors={{ temp: scalar(12), code: scalar(3) }} />);
		expect(container.querySelector('.wx-forecast')).toBeNull();
	});
});
