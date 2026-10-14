import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act, cleanup, within } from '@testing-library/react';
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
	it.each(['editMode', 'previewMode'] as const)(
		'keeps digital controls read-only in %s without overwriting live timer state',
		(flag) => {
			localStorage.clear();
			const live = render(<Timer widgetId="shared-preview" duration={50} />);
			act(() => fireEvent.click(live.getByLabelText('Start')));
			act(() => vi.advanceTimersByTime(2000));
			act(() => fireEvent.click(live.getByLabelText('Pause')));
			const saved = localStorage.getItem('widgetsack.timer.shared-preview');
			const preview = render(
				<Timer widgetId="shared-preview" duration={60} {...{ [flag]: true }} />
			);
			expect(localStorage.getItem('widgetsack.timer.shared-preview')).toBe(saved);
			expect(within(preview.container).getByLabelText('Start').hasAttribute('disabled')).toBe(true);
			expect(within(preview.container).getByLabelText('Reset').hasAttribute('disabled')).toBe(true);
			expect(localStorage.getItem('widgetsack.timer.shared-preview')).toBe(saved);
			preview.rerender(<Timer widgetId="shared-preview" duration={70} {...{ [flag]: true }} />);
			expect(localStorage.getItem('widgetsack.timer.shared-preview')).toBe(saved);
			expect(val(live.container)).toBe('00:48');
			localStorage.clear();
		}
	);
	// Pin the clock ON a tick boundary: the tick is the shared boundary-aligned useNow clock, so an
	// arbitrary real-time phase would make "how far past the flip" nondeterministic.
	beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
	afterEach(() => vi.useRealTimers());

	const val = (c: HTMLElement): string => c.querySelector('[data-part="value"]')?.textContent ?? '';
	it('starts a dial setting and counts down automatically; stopwatch keeps its digital view', () => {
		const { container, getByRole, rerender } = render(<Timer style="dial" duration={5000} />);
		expect(val(container)).toBe('60:00');
		fireEvent.keyDown(getByRole('slider'), { key: 'Home' });
		fireEvent.keyDown(getByRole('slider'), { key: 'ArrowUp' });
		expect(val(container)).toBe('01:00');
		act(() => vi.advanceTimersByTime(1000));
		expect(val(container)).toBe('00:59');
		rerender(<Timer style="dial" mode="stopwatch" />);
		expect(container.querySelector('[role="slider"]')).toBeNull();
	});

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

	it('uses widgetId to restore its state after remount', () => {
		localStorage.clear();
		const first = render(<Timer mode="stopwatch" widgetId="timer-widget" />);
		act(() => fireEvent.click(first.getByLabelText('Start')));
		act(() => vi.advanceTimersByTime(2000));
		first.unmount();
		act(() => vi.advanceTimersByTime(1000));
		const second = render(<Timer mode="stopwatch" widgetId="timer-widget" />);
		expect(val(second.container)).toBe('00:03');
		localStorage.clear();
	});

	it('keeps library instances apart and continues an older def-local timer', () => {
		localStorage.clear();
		const a = render(<Timer mode="stopwatch" widgetId="t" widgetInstanceId="lib-a/t" />);
		act(() => fireEvent.click(a.getByLabelText('Start')));
		act(() => vi.advanceTimersByTime(2000));
		const b = render(<Timer mode="stopwatch" widgetId="t" widgetInstanceId="lib-b/t" />);
		expect(val(b.container)).toBe('00:00');
		expect(localStorage.getItem('widgetsack.timer.t')).toBeNull();
		a.unmount();
		b.unmount();
		// A timer saved before instance keys existed is picked up through the legacy key.
		localStorage.setItem(
			'widgetsack.timer.old',
			localStorage.getItem('widgetsack.timer.lib-a/t') as string
		);
		const legacy = render(<Timer mode="stopwatch" widgetId="old" widgetInstanceId="lib-c/old" />);
		expect(val(legacy.container)).toBe('00:02');
		expect(localStorage.getItem('widgetsack.timer.lib-c/old')).not.toBeNull();
		localStorage.clear();
	});
});
