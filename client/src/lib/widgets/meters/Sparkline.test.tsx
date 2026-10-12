import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import Sparkline from './Sparkline';

// The chart is drawn into a <canvas>, which has no queryable DOM and no 2D context under happy-dom.
// Stub getContext with a recording context so the MODE WIRING is observable — which draw calls run
// for line vs histogram, fill on/off, axis on/off — while the geometry itself stays covered by the
// pure sparklineMath tests. (The full draw glue is coverage-excluded like CpuCoresCanvas.)
const ctx = {
	clearRect: vi.fn(),
	fillRect: vi.fn(),
	beginPath: vi.fn(),
	moveTo: vi.fn(),
	lineTo: vi.fn(),
	closePath: vi.fn(),
	fill: vi.fn(),
	stroke: vi.fn(),
	fillStyle: '',
	strokeStyle: '',
	globalAlpha: 1,
	lineWidth: 1,
	lineJoin: '',
	lineCap: ''
};

beforeEach(() => {
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
		ctx as unknown as CanvasRenderingContext2D
	);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	for (const v of Object.values(ctx)) if (typeof v === 'function') v.mockClear();
});

describe('Sparkline (canvas)', () => {
	it('blends updates between frames, reaches the exact sample, and stops scheduling', () => {
		const frames = new Map<number, FrameRequestCallback>();
		let next = 0;
		vi.spyOn(performance, 'now').mockReturnValue(0);
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
			frames.set(++next, callback);
			return next;
		});
		vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
			frames.delete(id);
		});
		const frame = (time: number) =>
			act(() => {
				const pending = [...frames.values()];
				frames.clear();
				pending.forEach((callback) => callback(time));
			});
		const { rerender, unmount } = render(
			<Sparkline history={[0, 20]} min={0} max={100} seconds={2} smooth />
		);
		expect(frames.size).toBe(0);
		rerender(<Sparkline history={[20, 40]} min={0} max={100} seconds={2} smooth />);
		expect(frames.size).toBe(1);
		ctx.lineTo.mockClear();
		frame(150);
		expect(ctx.lineTo).toHaveBeenCalledWith(0.75, 0.7);
		frame(300);
		expect(ctx.lineTo).toHaveBeenCalledWith(0.75, 0.6);
		expect(frames.size).toBe(0);
		vi.mocked(performance.now).mockReturnValue(300);
		rerender(<Sparkline history={[40, 60]} min={0} max={100} seconds={2} smooth />);
		frame(450);
		vi.mocked(performance.now).mockReturnValue(450);
		rerender(<Sparkline history={[60, 80]} min={0} max={100} seconds={2} smooth />);
		expect(frames.size).toBe(1);
		ctx.lineTo.mockClear();
		frame(600);
		expect(ctx.lineTo).toHaveBeenCalledWith(0.75, 0.35);
		frame(750);
		expect(ctx.lineTo).toHaveBeenCalledWith(0.75, expect.closeTo(0.2));
		expect(frames.size).toBe(0);
		rerender(<Sparkline history={[80, 100]} min={0} max={100} seconds={2} smooth />);
		unmount();
		expect(frames.size).toBe(0);
	});
	it('finishes a transition when the window hides without leaving a queued frame', () => {
		vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(42);
		const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
		const { rerender } = render(<Sparkline history={[0, 20]} smooth />);
		rerender(<Sparkline history={[20, 40]} smooth />);
		ctx.stroke.mockClear();
		act(() => document.dispatchEvent(new Event('visibilitychange')));
		expect(cancel).toHaveBeenCalledWith(42);
		expect(ctx.stroke).toHaveBeenCalledTimes(1);
	});
	it('cancels a pending transition when smoothing is disabled or motion is reduced', () => {
		const request = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(42);
		const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
		const { rerender } = render(<Sparkline history={[0, 20]} smooth />);
		rerender(<Sparkline history={[20, 40]} smooth />);
		expect(request).toHaveBeenCalledTimes(1);
		rerender(<Sparkline history={[40, 60]} />);
		expect(cancel).toHaveBeenCalledWith(42);
		vi.spyOn(window, 'matchMedia').mockReturnValue({
			matches: true,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn()
		} as unknown as MediaQueryList);
		rerender(<Sparkline history={[60, 80]} smooth />);
		expect(request).toHaveBeenCalledTimes(1);
	});
	it('keeps the themeable wrapper: classes, data-part/data-mode, role, and a canvas (no SVG)', () => {
		const { container } = render(<Sparkline history={[1, 2]} />);
		const wrap = container.querySelector('.sparkline.np-sparkline') as HTMLElement;
		expect(wrap.getAttribute('data-part')).toBe('sparkline');
		expect(wrap.getAttribute('data-mode')).toBe('line');
		expect(wrap.getAttribute('role')).toBe('img');
		expect(wrap.querySelector('canvas[data-part="chart"]')).not.toBeNull();
		expect(container.querySelector('svg')).toBeNull();
	});

	it('resolves colour through the wrapper: a config colour goes inline, else the stylesheet token', () => {
		const { container, rerender } = render(<Sparkline history={[1]} color="currentColor" />);
		const wrap = container.querySelector('.np-sparkline') as HTMLElement;
		expect(wrap.style.color.toLowerCase()).toBe('currentcolor'); // the ticker's inherit case
		rerender(<Sparkline history={[1]} />);
		expect(wrap.style.color).toBe(''); // no inline override → .np-sparkline's --np-accent applies
	});

	it('histogram mode fills one rect per bar plus the baseline axis, and no line stroke', () => {
		render(<Sparkline history={[10, 20]} histogram min={0} max={100} seconds={2} />);
		expect(ctx.fillRect).toHaveBeenCalledTimes(3); // 2 bars + axis
		expect(ctx.stroke).not.toHaveBeenCalled();
	});

	it('axis=false drops the baseline rect', () => {
		render(<Sparkline history={[10, 20]} histogram min={0} max={100} seconds={2} axis={false} />);
		expect(ctx.fillRect).toHaveBeenCalledTimes(2);
	});

	it('line mode strokes the polyline and fills the area under it (fill=false skips the area)', () => {
		const { rerender, container } = render(
			<Sparkline history={[10, 20, 30]} min={0} max={100} seconds={3} />
		);
		expect(container.querySelector('.np-sparkline')?.getAttribute('data-mode')).toBe('line');
		expect(ctx.stroke).toHaveBeenCalledTimes(1);
		expect(ctx.fill).toHaveBeenCalledTimes(1);
		expect(ctx.fillRect).not.toHaveBeenCalled();
		ctx.stroke.mockClear();
		ctx.fill.mockClear();
		rerender(<Sparkline history={[10, 20, 30]} min={0} max={100} seconds={3} fill={false} />);
		expect(ctx.stroke).toHaveBeenCalledTimes(1);
		expect(ctx.fill).not.toHaveBeenCalled();
	});

	it('an empty history clears the canvas and draws nothing', () => {
		render(<Sparkline history={[]} />);
		expect(ctx.clearRect).toHaveBeenCalled();
		expect(ctx.stroke).not.toHaveBeenCalled();
		expect(ctx.fillRect).not.toHaveBeenCalled();
	});

	it('redraws when the history updates (a new array each telemetry tick)', () => {
		const { rerender } = render(<Sparkline history={[1, 2]} seconds={2} />);
		expect(ctx.stroke).toHaveBeenCalledTimes(1);
		rerender(<Sparkline history={[2, 3]} seconds={2} />);
		expect(ctx.stroke).toHaveBeenCalledTimes(2);
	});
});
