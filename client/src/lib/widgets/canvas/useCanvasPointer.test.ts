import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { marqueeSelection, useCanvasPointer, type CanvasPointerDeps } from './useCanvasPointer';
import type { Pan } from './useZoomFit';
import type { Renderable } from '../../core/solve';

const canvasEl = document.createElement('div');
canvasEl.classList.add('canvas');
const widgetEl = document.createElement('div'); // not .canvas/.world

const state = { space: false };

const setPan = vi.fn();
const setSelection = vi.fn();
const clearSelection = vi.fn();

const deps: CanvasPointerDeps = {
	editMode: true,
	studio: true,
	overrides: () => ({}),
	spaceDown: () => state.space,
	pan: (): Pan => ({ panX: 0, panY: 0, zoom: 1 }),
	setPan,
	canvasRef: { current: document.createElement('div') },
	renderables: () => [],
	selectedIds: () => [],
	setSelection,
	clearSelection
};

type Over = Partial<{
	button: number;
	target: EventTarget;
	shiftKey: boolean;
	clientX: number;
	clientY: number;
}>;
const ev = (o: Over) =>
	({
		button: 0,
		clientX: 10,
		clientY: 10,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		metaKey: false,
		target: canvasEl,
		preventDefault: () => undefined,
		...o
	}) as unknown as React.MouseEvent;

// Release any window listeners a pan/marquee attached, and reset transient state between cases.
function release() {
	act(() => window.dispatchEvent(new MouseEvent('mouseup')));
}

const rend = (selectId: string, rect: { x: number; y: number; w: number; h: number }): Renderable =>
	({ selectId, rect }) as unknown as Renderable;

afterEach(() => {
	release();
	state.space = false;
	vi.clearAllMocks();
});

describe('marqueeSelection (pure)', () => {
	it('replaces selection with intersecting renderables; primary is the last added', () => {
		const rs = [
			rend('a', { x: 0, y: 0, w: 10, h: 10 }),
			rend('b', { x: 100, y: 100, w: 10, h: 10 })
		];
		const box = { x: 0, y: 0, w: 5, h: 5 };
		expect(marqueeSelection(rs, box, false, ['x'])).toEqual({ ids: ['a'], primary: 'a' });
	});

	it('additive merges into the current ids and de-dups', () => {
		const rs = [rend('b', { x: 0, y: 0, w: 10, h: 10 })];
		const box = { x: 0, y: 0, w: 5, h: 5 };
		expect(marqueeSelection(rs, box, true, ['a', 'b'])).toEqual({ ids: ['a', 'b'], primary: 'b' });
	});

	it('an empty hit yields no primary', () => {
		const rs = [rend('a', { x: 100, y: 100, w: 10, h: 10 })];
		expect(marqueeSelection(rs, { x: 0, y: 0, w: 1, h: 1 }, false, [])).toEqual({
			ids: [],
			primary: null
		});
	});
});

describe('useCanvasPointer registry-driven gestures', () => {
	it('middle-drag pans', () => {
		const { result } = renderHook(() => useCanvasPointer(deps));
		act(() => result.current.onCanvasMouseDown(ev({ button: 1 })));
		expect(result.current.panning).toBe(true);
	});

	it('Space + left-drag pans', () => {
		const { result } = renderHook(() => useCanvasPointer(deps));
		state.space = true;
		act(() => result.current.onCanvasMouseDown(ev({ button: 0 })));
		expect(result.current.panning).toBe(true);
	});

	it('a pan move translates panX/panY by the pointer delta, and mouseup ends panning', () => {
		const { result } = renderHook(() => useCanvasPointer(deps));
		act(() => result.current.onCanvasMouseDown(ev({ button: 1, clientX: 100, clientY: 50 })));
		act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 130, clientY: 70 })));
		// setPan was called with an updater. The pan origin (0,0) was captured at mousedown from
		// deps.pan(); the updater spreads the base pan only for `zoom`, and writes panX/panY from
		// the captured origin + the pointer delta (30, 20).
		const updater = setPan.mock.calls.at(-1)![0] as (p: Pan) => Pan;
		expect(updater({ panX: 5, panY: 6, zoom: 2 })).toEqual({ panX: 30, panY: 20, zoom: 2 });
		act(() => window.dispatchEvent(new MouseEvent('mouseup')));
		expect(result.current.panning).toBe(false);
	});

	it('left-drag on the empty canvas starts a marquee', () => {
		const { result } = renderHook(() => useCanvasPointer(deps));
		act(() => result.current.onCanvasMouseDown(ev({ button: 0, target: canvasEl })));
		expect(result.current.marquee).not.toBeNull();
		expect(result.current.panning).toBe(false);
		expect(clearSelection).toHaveBeenCalled();
	});

	it('left-drag that did not land on the canvas does nothing', () => {
		const { result } = renderHook(() => useCanvasPointer(deps));
		act(() => result.current.onCanvasMouseDown(ev({ button: 0, target: widgetEl })));
		expect(result.current.marquee).toBeNull();
		expect(result.current.panning).toBe(false);
	});

	it('a real drag updates the marquee rect on move and selects intersecting renderables on up', () => {
		const renderables = [rend('hit', { x: 0, y: 0, w: 200, h: 200 })];
		const { result } = renderHook(() =>
			useCanvasPointer({ ...deps, renderables: () => renderables })
		);
		act(() => result.current.onCanvasMouseDown(ev({ button: 0, clientX: 0, clientY: 0 })));
		act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 80 })));
		expect(result.current.marquee).toEqual({ x: 0, y: 0, w: 100, h: 80 });
		act(() => window.dispatchEvent(new MouseEvent('mouseup')));
		expect(result.current.marquee).toBeNull();
		expect(setSelection).toHaveBeenCalledWith(['hit'], 'hit');
	});

	it('a sub-3px drag is treated as a click and leaves the selection untouched', () => {
		const { result } = renderHook(() => useCanvasPointer(deps));
		act(() => result.current.onCanvasMouseDown(ev({ button: 0, clientX: 0, clientY: 0 })));
		act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: 1 })));
		act(() => window.dispatchEvent(new MouseEvent('mouseup')));
		expect(setSelection).not.toHaveBeenCalled();
	});

	it('Shift + left-drag is an additive marquee (no clearSelection)', () => {
		const { result } = renderHook(() => useCanvasPointer(deps));
		act(() =>
			result.current.onCanvasMouseDown(ev({ button: 0, shiftKey: true, clientX: 0, clientY: 0 }))
		);
		expect(clearSelection).not.toHaveBeenCalled();
		act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 50 })));
		act(() => window.dispatchEvent(new MouseEvent('mouseup')));
		expect(setSelection).toHaveBeenCalled();
	});

	it('does nothing when not in edit mode', () => {
		const { result } = renderHook(() => useCanvasPointer({ ...deps, editMode: false }));
		act(() => result.current.onCanvasMouseDown(ev({ button: 0 })));
		expect(result.current.marquee).toBeNull();
		expect(result.current.panning).toBe(false);
	});

	it('a right-click resolves to no gesture and does nothing', () => {
		const { result } = renderHook(() => useCanvasPointer(deps));
		act(() => result.current.onCanvasMouseDown(ev({ button: 2 })));
		expect(result.current.marquee).toBeNull();
		expect(result.current.panning).toBe(false);
	});

	it('falls back to raw client coords when the canvasRef is null', () => {
		const { result } = renderHook(() =>
			useCanvasPointer({ ...deps, canvasRef: { current: null } })
		);
		act(() => result.current.onCanvasMouseDown(ev({ button: 0, clientX: 7, clientY: 9 })));
		// toCanvas with no element returns the raw coords → marquee origin at (7, 9).
		expect(result.current.marquee).toEqual({ x: 7, y: 9, w: 0, h: 0 });
	});
});
