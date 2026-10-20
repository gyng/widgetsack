import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import CpuCoresCanvas from './CpuCoresCanvas';

const ctx = {
	save: vi.fn(),
	restore: vi.fn(),
	rect: vi.fn(),
	clip: vi.fn(),
	clearRect: vi.fn(),
	fillRect: vi.fn(),
	beginPath: vi.fn(),
	moveTo: vi.fn(),
	lineTo: vi.fn(),
	closePath: vi.fn(),
	fill: vi.fn(),
	stroke: vi.fn()
};
const options = {
	smoothDelay: 0,
	cols: 1,
	seconds: 2,
	histogram: false,
	lineWidth: 1,
	fill: false
};
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

it('scrolls CPU samples without morphing their values and stops when hidden or unmounted', () => {
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
	expect(frames.size).toBe(1);
	ctx.lineTo.mockClear();
	frame(500);
	expect(ctx.lineTo).toHaveBeenLastCalledWith(50, 40);
	frame(1000);
	expect(ctx.lineTo).toHaveBeenLastCalledWith(25, 40);
	expect(frames.size).toBe(0);
	vi.mocked(performance.now).mockReturnValue(1000);
	rerender(<CpuCoresCanvas {...options} cores={[[20, 40]]} smooth />);
	expect(ctx.moveTo).toHaveBeenLastCalledWith(25, 40);
	expect(ctx.lineTo).toHaveBeenLastCalledWith(75, 30);
	frame(1500);
	expect(ctx.lineTo).toHaveBeenLastCalledWith(50, 30);
	// A tick arriving 100ms early must not snap the existing 40% sample left.
	vi.mocked(performance.now).mockReturnValue(1900);
	rerender(<CpuCoresCanvas {...options} cores={[[40, 60]]} smooth />);
	expect(ctx.moveTo.mock.calls.at(-1)![0]).toBeCloseTo(30);
	expect(ctx.moveTo.mock.calls.at(-1)![1]).toBe(30);
	act(() => document.dispatchEvent(new Event('visibilitychange')));
	expect(frames.size).toBe(0);
	expect(ctx.lineTo).toHaveBeenLastCalledWith(75, 20);
	rerender(<CpuCoresCanvas {...options} cores={[[40, 60]]} smooth />);
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
	expect(request).toHaveBeenCalledTimes(1);
});
