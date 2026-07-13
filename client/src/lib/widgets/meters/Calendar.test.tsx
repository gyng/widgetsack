import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import Calendar from './Calendar';

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

// The meter self-sources the real date, so these assert STRUCTURE (the grid math is exhaustively
// covered in core/calendar.test.ts) — which holds whatever today happens to be.
describe('Calendar meter', () => {
	it('renders a 7-column weekday header and highlights today by default', () => {
		const { container } = render(<Calendar />);
		const grid = container.querySelector('.cal-grid');
		expect(grid?.getAttribute('role')).toBe('grid');
		expect(grid?.getAttribute('aria-label')).toMatch(/\w+ \d{4}/);
		expect(container.querySelectorAll('.cal-head .cal-wd')).toHaveLength(7);
		expect(container.querySelectorAll('.cal-today')).toHaveLength(1); // today is in the month grid
		const rows = container.querySelectorAll('.cal-row:not(.cal-head)');
		expect(rows.length).toBeGreaterThanOrEqual(4);
		rows.forEach((r) => expect(r.querySelectorAll('.cal-day')).toHaveLength(7));
	});

	it('omits the header and today highlight when those options are off', () => {
		const { container } = render(<Calendar weekdayHeader={false} highlightToday={false} />);
		expect(container.querySelector('.cal-head')).toBeNull();
		expect(container.querySelector('.cal-today')).toBeNull();
	});

	it('starts the week on Monday when configured', () => {
		const { container } = render(<Calendar firstDay="Monday" />);
		const heads = container.querySelectorAll('.cal-head .cal-wd');
		expect(heads[0].textContent).toBe('Mon');
		expect(heads[6].textContent).toBe('Sun');
	});

	it('continuous mode renders more weeks than the default month view', () => {
		const monthRows = render(<Calendar />).container.querySelectorAll(
			'.cal-row:not(.cal-head)'
		).length;
		cleanup();
		const contRows = render(<Calendar continuous />).container.querySelectorAll(
			'.cal-row:not(.cal-head)'
		).length;
		expect(contRows).toBeGreaterThan(monthRows);
	});

	it('applies a per-instance color as the --cal-accent CSS variable', () => {
		const { container } = render(<Calendar color="rgb(4,2,0)" />);
		const root = container.querySelector('.np-calendar') as HTMLElement;
		expect(root.style.getPropertyValue('--cal-accent')).toBe('rgb(4,2,0)');
	});

	it('re-reads the date on the slow minute tick (so "today" flips past midnight)', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2027, 0, 31, 23, 59, 30));
		const { container } = render(<Calendar />);
		expect(container.querySelectorAll('.cal-today')).toHaveLength(1);
		const beforeTitle = container.querySelector('.cal-title')?.textContent;
		vi.setSystemTime(new Date(2027, 1, 1, 0, 0, 30));
		act(() => {
			vi.advanceTimersByTime(60_000);
		});
		expect(container.querySelector('.cal-title')?.textContent).not.toBe(beforeTitle);
	});
});
