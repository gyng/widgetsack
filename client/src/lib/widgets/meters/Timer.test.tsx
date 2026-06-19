import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import Timer, { TimerView } from './Timer';

afterEach(cleanup);

describe('TimerView', () => {
	it('renders the time and label', () => {
		const { getByText } = render(<TimerView time="05:00" label="Pomodoro" />);
		expect(getByText('05:00')).toBeTruthy();
		expect(getByText('Pomodoro')).toBeTruthy();
	});

	it('shows a start control when stopped and a pause control when running', () => {
		const noop = () => undefined;
		const { getByLabelText, rerender } = render(<TimerView time="05:00" onToggle={noop} />);
		expect(getByLabelText('Start')).toBeTruthy();
		rerender(<TimerView time="04:59" running onToggle={noop} />);
		expect(getByLabelText('Pause')).toBeTruthy();
	});

	it('fires onToggle and onReset', () => {
		const onToggle = vi.fn();
		const onReset = vi.fn();
		const { getByLabelText } = render(
			<TimerView time="00:00" onToggle={onToggle} onReset={onReset} />
		);
		fireEvent.click(getByLabelText('Start'));
		fireEvent.click(getByLabelText('Reset'));
		expect(onToggle).toHaveBeenCalledOnce();
		expect(onReset).toHaveBeenCalledOnce();
	});

	it('marks the done state', () => {
		const { container } = render(<TimerView time="00:00" done />);
		expect(container.querySelector('.timer.is-done')).toBeTruthy();
	});

	it('renders no label when none is given', () => {
		const { container } = render(<TimerView time="00:00" />);
		expect(container.querySelector('[data-part="label"]')).toBeNull();
	});

	it('renders no controls block when neither callback is given', () => {
		const { container } = render(<TimerView time="00:00" />);
		expect(container.querySelector('[data-part="controls"]')).toBeNull();
	});

	it('renders only the reset control when onToggle is absent', () => {
		const onReset = vi.fn();
		const { container, getByLabelText } = render(<TimerView time="00:00" onReset={onReset} />);
		expect(getByLabelText('Reset')).toBeTruthy();
		expect(container.querySelector('[title="Start"]')).toBeNull();
	});

	it('applies an explicit color inline; without one it leans on the token (no rgb override)', () => {
		const a = render(<TimerView time="00:00" color="rgb(1, 2, 3)" />);
		expect((a.container.querySelector('[data-part="root"]') as HTMLElement).style.color).toBe(
			'rgb(1, 2, 3)'
		);
		a.unmount();
		// Default branch sets color to the var() token fallback; happy-dom's CSSOM can't store a
		// var() color, so the observable effect is simply no concrete rgb() override.
		const b = render(<TimerView time="00:00" />);
		expect((b.container.querySelector('[data-part="root"]') as HTMLElement).style.color).toBe('');
	});
});

describe('Timer (default, self-sourcing) wires useTimer to TimerView', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const val = (c: HTMLElement): string => c.querySelector('[data-part="value"]')?.textContent ?? '';

	it('shows a paused countdown at its full duration (ceiling) and counts down on start', () => {
		const { container, getByLabelText } = render(<Timer mode="countdown" duration={5} />);
		expect(val(container)).toBe('00:05');
		act(() => fireEvent.click(getByLabelText('Start')));
		// Past 1.2s: 3.8s left → ceil reads 00:04.
		act(() => vi.advanceTimersByTime(1200));
		expect(val(container)).toBe('00:04');
		expect(getByLabelText('Pause')).toBeTruthy();
	});

	it('a stopwatch floors elapsed seconds', () => {
		const { container, getByLabelText } = render(<Timer mode="stopwatch" />);
		expect(val(container)).toBe('00:00');
		act(() => fireEvent.click(getByLabelText('Start')));
		act(() => vi.advanceTimersByTime(1900));
		expect(val(container)).toBe('00:01');
	});

	it('reset returns the value to the start', () => {
		const { container, getByLabelText } = render(<Timer mode="stopwatch" />);
		act(() => fireEvent.click(getByLabelText('Start')));
		act(() => vi.advanceTimersByTime(3000));
		expect(val(container)).toBe('00:03');
		act(() => fireEvent.click(getByLabelText('Reset')));
		expect(val(container)).toBe('00:00');
	});

	it('honours the label and a custom format', () => {
		const { container } = render(
			<Timer mode="countdown" duration={3600} format="hh:mm:ss" label="Pomodoro" />
		);
		expect(container.querySelector('[data-part="label"]')?.textContent).toBe('Pomodoro');
		expect(val(container)).toBe('01:00:00');
	});
});
