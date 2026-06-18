// useZoomFit owns the studio world transform: fit() scales+centers the monitor work area into the
// measured stage, an effect auto-fits once per monitor/size key (studio only), and a NATIVE wheel
// listener zooms toward the cursor (gated on the studio.zoom control). The math is pure-testable;
// the wheel/auto-fit paths are exercised by stubbing getBoundingClientRect and dispatching a real
// WheelEvent on a happy-dom element (importing the hook also registers the controls defaults, so the
// studio.zoom gate resolves). See useCanvasPointer.test.ts for the native-listener-on-a-ref pattern.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useZoomFit } from './useZoomFit';
import type { ControlOverrides } from '../../core/controls';

type Opts = Parameters<typeof useZoomFit>[0];

// A canvas element with a stubbed bounding rect (happy-dom returns zeros otherwise). `left`/`top`
// become the wheel handler's origin for the cursor→world math.
function makeCanvas(left = 0, top = 0): HTMLDivElement {
	const el = document.createElement('div');
	el.classList.add('canvas');
	el.getBoundingClientRect = () =>
		({
			left,
			top,
			width: 0,
			height: 0,
			right: 0,
			bottom: 0,
			x: left,
			y: top,
			toJSON: () => ({})
		} as DOMRect);
	document.body.appendChild(el);
	return el;
}

function baseOpts(over: Partial<Opts> = {}): Opts {
	return {
		studio: true,
		myMonitor: 'm1',
		monSize: { w: 1000, h: 500 },
		stageW: 800,
		stageH: 600,
		canvasRef: { current: makeCanvas() },
		...over
	};
}

function wheel(deltaY: number, at: { x: number; y: number }, mods: Partial<WheelEventInit> = {}) {
	const ev = new WheelEvent('wheel', {
		deltaY,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		bubbles: true,
		cancelable: true,
		...mods
	});
	// happy-dom's WheelEvent ctor drops clientX/clientY — set them so the cursor→world math runs.
	Object.defineProperty(ev, 'clientX', { value: at.x, configurable: true });
	Object.defineProperty(ev, 'clientY', { value: at.y, configurable: true });
	return ev;
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('fit() — scale + center math', () => {
	it('scales to the limiting axis * 0.95 and centers the world in the stage', () => {
		// limiting axis: 800/1000 = 0.8 vs 600/500 = 1.2 → min 0.8 * 0.95 = 0.76
		const { result } = renderHook(() => useZoomFit(baseOpts()));
		act(() => result.current.fit());
		const zoom = Math.min(800 / 1000, 600 / 500) * 0.95;
		expect(result.current.zoom).toBeCloseTo(0.76, 10);
		expect(result.current.zoom).toBe(zoom);
		expect(result.current.panX).toBeCloseTo((800 - 1000 * zoom) / 2, 10);
		expect(result.current.panY).toBeCloseTo((600 - 500 * zoom) / 2, 10);
	});

	it('is a no-op when the monitor size is zero (nothing to fit yet)', () => {
		// Disable auto-fit (overlay) so only the explicit fit() under test runs.
		const { result } = renderHook(() =>
			useZoomFit(baseOpts({ studio: false, monSize: { w: 0, h: 0 } }))
		);
		const before = { ...result.current };
		act(() => result.current.fit());
		expect(result.current.zoom).toBe(before.zoom);
		expect(result.current.panX).toBe(before.panX);
		expect(result.current.panY).toBe(before.panY);
	});

	it('is a no-op when the stage has not been measured yet (stageW/H = 0)', () => {
		const { result } = renderHook(() =>
			useZoomFit(baseOpts({ studio: false, stageW: 0, stageH: 0 }))
		);
		act(() => result.current.fit());
		expect(result.current).toMatchObject({ zoom: 1, panX: 0, panY: 0 });
	});
});

describe('initial pan + auto-fit effect', () => {
	it('overlay (studio=false) stays at the identity transform — no auto-fit', () => {
		const { result } = renderHook(() => useZoomFit(baseOpts({ studio: false })));
		expect(result.current).toMatchObject({ zoom: 1, panX: 0, panY: 0 });
	});

	it('studio auto-fits on first real measure', () => {
		const { result } = renderHook(() => useZoomFit(baseOpts()));
		// The mount effect fit()s immediately because studio + sizes are all > 0.
		expect(result.current.zoom).toBeCloseTo(Math.min(800 / 1000, 600 / 500) * 0.95, 10);
	});

	it('does not auto-fit again for the SAME monitor/size key after a manual zoom', () => {
		const opts = baseOpts();
		const { result, rerender } = renderHook((p: Opts) => useZoomFit(p), { initialProps: opts });
		// Manually drift the zoom, then rerender with the SAME key — the effect must not re-fit.
		act(() => result.current.setPan({ zoom: 2, panX: 11, panY: 22 }));
		rerender({ ...opts });
		expect(result.current).toMatchObject({ zoom: 2, panX: 11, panY: 22 });
	});

	it('auto-fits AGAIN when the monitor key changes (different monitor)', () => {
		const opts = baseOpts();
		const { result, rerender } = renderHook((p: Opts) => useZoomFit(p), { initialProps: opts });
		act(() => result.current.setPan({ zoom: 2, panX: 11, panY: 22 }));
		// Switch monitors → new key → re-fit.
		rerender({ ...opts, myMonitor: 'm2' });
		expect(result.current.zoom).toBeCloseTo(Math.min(800 / 1000, 600 / 500) * 0.95, 10);
		expect(result.current.zoom).not.toBe(2);
	});
});

describe('wheel zoom (native listener)', () => {
	it('zooms IN toward the cursor on a negative deltaY and preventDefaults', () => {
		const canvas = makeCanvas(10, 20);
		const { result } = renderHook(() => useZoomFit(baseOpts({ canvasRef: { current: canvas } })));
		// Reset to a known transform so the cursor→world math is checkable.
		act(() => result.current.setPan({ zoom: 1, panX: 0, panY: 0 }));

		const ev = wheel(-100, { x: 110, y: 220 }); // cursor at (cx=100, cy=200) inside the canvas
		act(() => {
			canvas.dispatchEvent(ev);
		});
		// next zoom = 1 * 1.1; world point under the cursor is preserved, so panX = cx - wx*next where
		// wx = (cx - 0)/1 = 100, cx = 110-10 = 100.
		const next = 1.1;
		expect(result.current.zoom).toBeCloseTo(next, 10);
		expect(result.current.panX).toBeCloseTo(100 - 100 * next, 10);
		expect(result.current.panY).toBeCloseTo(200 - 200 * next, 10);
		expect(ev.defaultPrevented).toBe(true);
	});

	it('zooms OUT on a positive deltaY (1/1.1)', () => {
		const canvas = makeCanvas();
		const { result } = renderHook(() => useZoomFit(baseOpts({ canvasRef: { current: canvas } })));
		act(() => result.current.setPan({ zoom: 1, panX: 0, panY: 0 }));
		act(() => {
			canvas.dispatchEvent(wheel(100, { x: 0, y: 0 }));
		});
		expect(result.current.zoom).toBeCloseTo(1 / 1.1, 10);
	});

	it('clamps zoom-in at the 4x ceiling', () => {
		const canvas = makeCanvas();
		const { result } = renderHook(() => useZoomFit(baseOpts({ canvasRef: { current: canvas } })));
		act(() => result.current.setPan({ zoom: 4, panX: 0, panY: 0 }));
		act(() => {
			canvas.dispatchEvent(wheel(-100, { x: 0, y: 0 }));
		});
		expect(result.current.zoom).toBe(4);
	});

	it('clamps zoom-out at the 0.05x floor', () => {
		const canvas = makeCanvas();
		const { result } = renderHook(() => useZoomFit(baseOpts({ canvasRef: { current: canvas } })));
		act(() => result.current.setPan({ zoom: 0.05, panX: 0, panY: 0 }));
		act(() => {
			canvas.dispatchEvent(wheel(100, { x: 0, y: 0 }));
		});
		expect(result.current.zoom).toBe(0.05);
	});

	it('ignores wheel events over a docked rail / toolbar (does not hijack their scroll)', () => {
		const canvas = makeCanvas();
		const rail = document.createElement('div');
		rail.classList.add('inspector'); // one of the bail-out selectors
		canvas.appendChild(rail);
		const { result } = renderHook(() => useZoomFit(baseOpts({ canvasRef: { current: canvas } })));
		act(() => result.current.setPan({ zoom: 1, panX: 0, panY: 0 }));
		const ev = wheel(-100, { x: 0, y: 0 });
		// Dispatch ON the rail child; the listener (on .canvas, via bubbling) should bail.
		act(() => {
			rail.dispatchEvent(ev);
		});
		expect(result.current.zoom).toBe(1);
		expect(ev.defaultPrevented).toBe(false);
	});

	it('does not zoom in the overlay (studio=false → studio.zoom gate fails)', () => {
		const canvas = makeCanvas();
		const { result } = renderHook(() =>
			useZoomFit(baseOpts({ studio: false, canvasRef: { current: canvas } }))
		);
		act(() => result.current.setPan({ zoom: 1, panX: 0, panY: 0 }));
		const ev = wheel(-100, { x: 0, y: 0 });
		act(() => {
			canvas.dispatchEvent(ev);
		});
		expect(result.current.zoom).toBe(1);
		expect(ev.defaultPrevented).toBe(false);
	});

	it('a disabling override on studio.zoom suppresses the wheel zoom (read live via ref)', () => {
		const canvas = makeCanvas();
		// overrides() returns a fresh fn each render; the hook reads it through a ref without
		// re-subscribing. Disabling studio.zoom drops it from the matcher → no zoom.
		const overrides = (): ControlOverrides => ({ 'studio.zoom': { disabled: true } });
		const { result } = renderHook(() =>
			useZoomFit(baseOpts({ canvasRef: { current: canvas }, overrides }))
		);
		act(() => result.current.setPan({ zoom: 1, panX: 0, panY: 0 }));
		const ev = wheel(-100, { x: 0, y: 0 });
		act(() => {
			canvas.dispatchEvent(ev);
		});
		expect(result.current.zoom).toBe(1);
		expect(ev.defaultPrevented).toBe(false);
	});

	it('is inert when the canvas ref is null (effect bails, hook still usable)', () => {
		// The wheel effect early-returns with no element to attach to; the hook must still render and
		// expose a working transform.
		const { result } = renderHook(() =>
			useZoomFit(baseOpts({ studio: false, canvasRef: { current: null } }))
		);
		expect(result.current).toMatchObject({ zoom: 1, panX: 0, panY: 0 });
		act(() => result.current.setPan({ zoom: 2, panX: 0, panY: 0 }));
		expect(result.current.zoom).toBe(2);
	});

	it('removes the wheel listener on unmount (no zoom after teardown)', () => {
		const canvas = makeCanvas();
		const { result, unmount } = renderHook(() =>
			useZoomFit(baseOpts({ canvasRef: { current: canvas } }))
		);
		act(() => result.current.setPan({ zoom: 1, panX: 0, panY: 0 }));
		const zoomBefore = result.current.zoom;
		unmount();
		// After unmount the cleanup detached the listener; dispatching must not change anything observable.
		canvas.dispatchEvent(wheel(-100, { x: 0, y: 0 }));
		expect(result.current.zoom).toBe(zoomBefore);
	});
});

describe('setPan passthrough', () => {
	it('exposes setPan to drive the world transform directly (Fit button / drag math)', () => {
		const { result } = renderHook(() => useZoomFit(baseOpts({ studio: false })));
		act(() => result.current.setPan({ zoom: 3, panX: 5, panY: 7 }));
		expect(result.current).toMatchObject({ zoom: 3, panX: 5, panY: 7 });
	});
});
