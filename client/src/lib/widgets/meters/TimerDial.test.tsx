import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import TimerDial from './TimerDial';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
const mount = (overrides = {}) => {
	const onSet = vi.fn(),
		onToggle = vi.fn();
	const props = {
		seconds: 300,
		running: false,
		done: false,
		label: '',
		disabled: false,
		onSet,
		onToggle,
		...overrides
	};
	const view = render(<TimerDial {...props} />);
	const slider = view.getByRole('slider');
	vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 200));
	Object.defineProperty(slider, 'setPointerCapture', { value: vi.fn(), configurable: true });
	Object.defineProperty(slider, 'releasePointerCapture', { value: vi.fn(), configurable: true });
	return { ...view, slider, onSet, onToggle, props };
};
const pointer = (x: number, y: number, pointerId = 1, button = 0) => ({
	clientX: x,
	clientY: y,
	pointerId,
	button
});
describe('timer dial interactions', () => {
	it('previews a drag without starting until release, and ignores other pointers', () => {
		const { slider, onSet, getByText } = mount({ label: 'Kitchen', color: 'tomato' });
		fireEvent.pointerMove(slider, pointer(100, 0));
		fireEvent.pointerUp(slider, pointer(100, 0));
		fireEvent.pointerDown(slider, pointer(100, 0, 1, 2));
		expect(onSet).not.toHaveBeenCalled();
		fireEvent.pointerDown(slider, pointer(100, 0));
		expect(getByText('Release to start')).toBeTruthy();
		expect(slider).toHaveAttribute('aria-valuenow', '30');
		fireEvent.pointerDown(slider, pointer(200, 100, 2));
		expect(slider).toHaveAttribute('aria-valuenow', '30');
		fireEvent.pointerMove(slider, pointer(200, 100, 2));
		fireEvent.pointerUp(slider, pointer(200, 100, 2));
		expect(slider).toHaveAttribute('aria-valuenow', '30');
		fireEvent.pointerMove(slider, pointer(200, 100));
		expect(slider).toHaveAttribute('aria-valuenow', '48');
		expect(onSet).not.toHaveBeenCalled();
		fireEvent.pointerUp(slider, pointer(200, 100));
		expect(onSet).toHaveBeenCalledWith(2880);
	});
	it('keeps the current setting when grabbing the center and discards cancelled gestures', () => {
		const { slider, onSet } = mount();
		fireEvent.pointerDown(slider.querySelector('.dial-grip')!, pointer(110, 110));
		expect(slider).toHaveAttribute('aria-valuenow', '5');
		fireEvent.pointerCancel(slider);
		fireEvent.pointerDown(slider, pointer(100, 100));
		expect(slider).toHaveAttribute('aria-valuenow', '5');
		fireEvent.pointerMove(slider, pointer(100, 100));
		fireEvent.pointerCancel(slider);
		fireEvent.pointerUp(slider, pointer(100, 100));
		expect(onSet).not.toHaveBeenCalled();
		fireEvent.pointerDown(slider, pointer(100, 0));
		fireEvent.lostPointerCapture(slider);
		expect(slider).toHaveAttribute('aria-valuenow', '5');
	});
	it('supports keyboard settings, pause, reset and the completion hint', () => {
		const { slider, onSet, onToggle, getByRole, rerender, props, getByText } = mount({
			running: true
		});
		for (const [key, seconds] of [
			['ArrowUp', 360],
			['ArrowDown', 240],
			['PageUp', 600],
			['PageDown', 0],
			['Home', 0],
			['End', 3600]
		] as const) {
			fireEvent.keyDown(slider, { key });
			expect(onSet).toHaveBeenLastCalledWith(seconds);
		}
		fireEvent.keyDown(slider, { key: 'Tab' });
		fireEvent.click(getByRole('button', { name: 'Pause' }));
		expect(onToggle).toHaveBeenCalledOnce();
		fireEvent.click(getByRole('button', { name: 'Reset' }));
		expect(onSet).toHaveBeenLastCalledWith(0);
		rerender(<TimerDial {...props} running={false} done seconds={0} />);
		expect(getByText('Time’s up')).toBeTruthy();
		expect(getByRole('button', { name: 'Start' })).toBeDisabled();
	});
	it('blocks editing and a gesture released after editing becomes disabled', () => {
		const { slider, onSet, rerender, props } = mount();
		fireEvent.pointerDown(slider, pointer(100, 0));
		rerender(<TimerDial {...props} disabled />);
		fireEvent.pointerUp(slider, pointer(100, 0));
		fireEvent.pointerDown(slider, pointer(100, 0));
		fireEvent.keyDown(slider, { key: 'End' });
		expect(onSet).not.toHaveBeenCalled();
	});
});
