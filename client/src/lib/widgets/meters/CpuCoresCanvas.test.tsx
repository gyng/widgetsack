import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import CpuCoresCanvas from './CpuCoresCanvas';

const ctx = {
	clearRect: vi.fn(),
	fillRect: vi.fn(),
	beginPath: vi.fn(),
	moveTo: vi.fn(),
	lineTo: vi.fn(),
	closePath: vi.fn(),
	fill: vi.fn(),
	stroke: vi.fn()
};
const options = { cols: 1, seconds: 2, histogram: false, lineWidth: 1, fill: false };
beforeEach(() => {
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
		ctx as unknown as CanvasRenderingContext2D
	);
	vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
	vi.spyOn(HTMLCanvasElement.prototype, 'clientHeight', 'get').mockReturnValue(50);
	vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

it('animates CPU ticks to their exact values and cancels work when hidden or unmounted', () => {
	const frames = new Map<number, FrameRequestCallback>();
	let next = 0;
	vi.spyOn(performance, 'now').mockReturnValue(0);
	vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
		frames.set(++next, cb);
		return next;
	});
	vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
		frames.delete(id);
	});
	const frame = (time: number) =>
		act(() => {
			const pending = [...frames.values()];
			frames.clear();
			pending.forEach((cb) => cb(time));
		});
	const { rerender, unmount } = render(<CpuCoresCanvas {...options} cores={[[0, 20]]} smooth />);
	expect(frames.size).toBe(0);
	rerender(<CpuCoresCanvas {...options} cores={[[20, 40]]} smooth />);
	expect(frames.size).toBe(1);
	ctx.lineTo.mockClear();
	frame(150);
	expect(ctx.lineTo).toHaveBeenCalledWith(75, 35);
	frame(300);
	expect(ctx.lineTo).toHaveBeenCalledWith(75, 30);
	expect(frames.size).toBe(0);
	rerender(<CpuCoresCanvas {...options} cores={[[40, 60]]} smooth />);
	act(() => document.dispatchEvent(new Event('visibilitychange')));
	expect(frames.size).toBe(0);
	expect(ctx.lineTo).toHaveBeenCalledWith(75, 20);
	rerender(<CpuCoresCanvas {...options} cores={[[60, 80]]} smooth />);
	unmount();
	expect(frames.size).toBe(0);
});
it('uses immediate updates by default, with reduced motion, and when core count changes', () => {
	const request = vi.spyOn(window, 'requestAnimationFrame');
	const { rerender } = render(<CpuCoresCanvas {...options} cores={[[0, 20]]} />);
	rerender(<CpuCoresCanvas {...options} cores={[[20, 40]]} />);
	expect(request).not.toHaveBeenCalled();
	vi.spyOn(window, 'matchMedia').mockReturnValue({
		matches: true,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn()
	} as unknown as MediaQueryList);
	rerender(<CpuCoresCanvas {...options} cores={[[40, 60]]} smooth />);
	expect(request).not.toHaveBeenCalled();
	vi.mocked(window.matchMedia).mockReturnValue({
		matches: false,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn()
	} as unknown as MediaQueryList);
	rerender(
		<CpuCoresCanvas
			{...options}
			cores={[
				[60, 80],
				[20, 30]
			]}
			smooth
		/>
	);
	expect(request).not.toHaveBeenCalled();
});
