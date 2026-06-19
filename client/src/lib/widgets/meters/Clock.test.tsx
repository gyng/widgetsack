import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import Clock from './Clock';

afterEach(cleanup);

describe('Clock (digital) is bare DOM, color via CSS variable', () => {
	it('passes a per-instance color as --clock-color, not an inline color', () => {
		const { container } = render(<Clock format="HH:mm" color="rgb(1, 2, 3)" />);
		const root = container.querySelector('.np-clock') as HTMLElement;
		expect(root.style.getPropertyValue('--clock-color')).toBe('rgb(1, 2, 3)');
		expect(root.style.color).toBe(''); // look lives in CSS, not inline
	});

	it('sets no inline style when no color is given (theme token drives it)', () => {
		const { container } = render(<Clock format="HH:mm" />);
		const root = container.querySelector('.np-clock') as HTMLElement;
		expect(root.getAttribute('style')).toBeNull();
	});

	it('renders the formatted value and an optional label', () => {
		const { container } = render(<Clock format="HH:mm" label="JST" />);
		expect(container.querySelector('[data-part="value"]')?.textContent).toMatch(/^\d{2}:\d{2}$/);
		expect(container.querySelector('[data-part="label"]')?.textContent).toBe('JST');
	});

	it('renders no label element when none is given', () => {
		const { container } = render(<Clock format="HH:mm" />);
		expect(container.querySelector('[data-part="label"]')).toBeNull();
	});
});

describe('Clock ticks on a 1s interval', () => {
	beforeEach(() => vi.useFakeTimers({ now: new Date('2020-01-01T10:00:00') }));
	afterEach(() => vi.useRealTimers());

	it('re-reads the time each second so the display advances', () => {
		const { container } = render(<Clock format="HH:mm:ss" />);
		const value = (): string => container.querySelector('[data-part="value"]')?.textContent ?? '';
		expect(value()).toBe('10:00:00');
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(value()).toBe('10:00:02');
	});
});
