import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import Countdown from './Countdown';

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe('Countdown meter', () => {
	it('counts down to a target date in event mode', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const target = new Date('2026-01-02T02:03:04Z').toISOString();
		const { container } = render(<Countdown mode="event" target={target} format="dhms" />);
		expect(container.querySelector('.cd-value')?.textContent).toBe('1d 02:03:04');
		expect(container.querySelector('.countdown')?.getAttribute('data-phase')).toBe('counting');
	});

	it('stops at zero once reached, or counts up when enabled', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
		const past = new Date('2026-01-01T00:00:00Z').toISOString();

		const stopped = render(<Countdown mode="event" target={past} />).container;
		expect(stopped.querySelector('.countdown')?.getAttribute('data-phase')).toBe('reached');
		expect(stopped.querySelector('.cd-value')?.textContent).toBe('0:00');
		cleanup();

		const up = render(<Countdown mode="event" target={past} countUp />).container;
		expect(up.querySelector('.countdown')?.getAttribute('data-phase')).toBe('elapsed');
		expect(up.querySelector('.cd-value')?.textContent).toBe('+0:10');
	});

	it('shows a hint with no target', () => {
		const { container } = render(<Countdown mode="event" target="" />);
		expect(container.querySelector('.cd-value')?.textContent).toBe('—');
		expect(container.querySelector('.cd-sub')?.textContent).toBe('set a target date');
	});

	it('shows the pomodoro phase + remaining', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const { container } = render(<Countdown mode="pomodoro" workMin={25} breakMin={5} />);
		// Freshly mounted → full work phase.
		expect(container.querySelector('.countdown')?.getAttribute('data-phase')).toBe('work');
		expect(container.querySelector('.cd-value')?.textContent).toBe('25:00');
		expect(container.querySelector('.cd-sub')?.textContent).toContain('Work');
	});
});
