import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import SunMoon from './SunMoon';
import type { SensorState } from '../../core/telemetry';

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const tx = (v: string): SensorState => ({ value: { kind: 'text', value: v }, history: [] });

describe('SunMoon meter', () => {
	it('shows sunrise/sunset HH:mm from the weather sensors', () => {
		const { container } = render(
			<SunMoon sensors={{ rise: tx('2026-06-14T05:12'), set: tx('2026-06-14T21:30') }} />
		);
		const times = [...container.querySelectorAll('.sm-time')].map((e) => e.textContent);
		expect(times).toEqual(['05:12', '21:30']);
	});

	it('renders the moon phase for the current date', () => {
		vi.useFakeTimers();
		// A reference full moon ~ half a synodic month after 2000-01-06 18:14 UTC.
		vi.setSystemTime(new Date(Date.UTC(2000, 0, 6, 18, 14) + 14.77 * 86_400_000));
		const { container } = render(<SunMoon sensors={{}} />);
		expect(container.querySelector('.sm-moon-name')?.textContent).toBe('Full');
		expect(container.querySelector('.sm-moon-illum')?.textContent).toContain('100% lit');
	});

	it('dashes the sun times before weather arrives', () => {
		const { container } = render(<SunMoon sensors={{}} />);
		const times = [...container.querySelectorAll('.sm-time')].map((e) => e.textContent);
		expect(times).toEqual(['—', '—']);
	});
});
