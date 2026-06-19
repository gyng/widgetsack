import { beforeEach, describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { clampPane, applyDelta, PANE_DEFAULTS, usePaneSizes, type Edge } from './usePaneSizes';

const KEY = 'widgetsack.studio.panes';

describe('clampPane', () => {
	it('clamps each edge to its limits and rounds', () => {
		expect(clampPane('left', 10)).toBe(180); // below min
		expect(clampPane('left', 9999)).toBe(520); // above max
		expect(clampPane('tree', 200.4)).toBe(200); // rounds
		expect(clampPane('right', 300)).toBe(300); // within range
	});
});

describe('applyDelta', () => {
	it('widens the left rail as its divider moves right (+dx)', () => {
		expect(applyDelta(PANE_DEFAULTS, 'left', 250, 40).railL).toBe(290);
		expect(applyDelta(PANE_DEFAULTS, 'left', 250, -40).railL).toBe(210);
	});

	it('widens the tree column with +dx', () => {
		expect(applyDelta(PANE_DEFAULTS, 'tree', 200, 30).treeW).toBe(230);
	});

	it('widens the RIGHT rail as its divider moves LEFT (-dx grows it)', () => {
		expect(applyDelta(PANE_DEFAULTS, 'right', 264, -50).railR).toBe(314);
		expect(applyDelta(PANE_DEFAULTS, 'right', 264, 50).railR).toBe(214);
	});

	it('only touches the dragged edge', () => {
		const out = applyDelta(PANE_DEFAULTS, 'left', 250, 40);
		expect(out.railR).toBe(PANE_DEFAULTS.railR);
		expect(out.treeW).toBe(PANE_DEFAULTS.treeW);
	});

	it('respects the clamp at the extremes', () => {
		expect(applyDelta(PANE_DEFAULTS, 'left', 500, 999).railL).toBe(520);
	});
});

describe('usePaneSizes', () => {
	beforeEach(() => localStorage.clear());

	// A React-pointer-event-shaped object for startResize.
	const reactDown = (clientX: number): ReactPointerEvent => {
		const e = { clientX, preventDefault: () => undefined };
		return e as unknown as ReactPointerEvent;
	};

	it('overlay role uses defaults and emits no inline vars', () => {
		const { result } = renderHook(() => usePaneSizes(false));
		expect(result.current.vars).toEqual({});
	});

	it('studio role seeds from defaults and exposes inline CSS vars', () => {
		const { result } = renderHook(() => usePaneSizes(true));
		expect(result.current.vars).toEqual({
			'--rail-l': '250px',
			'--rail-r': '264px',
			'--tree-w': '200px'
		});
	});

	it('studio role loads + clamps persisted sizes (ignoring bad fields)', () => {
		localStorage.setItem(
			KEY,
			JSON.stringify({ railL: 9999, railR: 'nope', treeW: 150 }) // railL over max, railR wrong type
		);
		const { result } = renderHook(() => usePaneSizes(true));
		expect(result.current.vars).toEqual({
			'--rail-l': '520px', // clamped to max
			'--rail-r': '264px', // non-number → default
			'--tree-w': '150px'
		});
	});

	it('studio role loads all-valid persisted numbers verbatim (within range)', () => {
		localStorage.setItem(KEY, JSON.stringify({ railL: 300, railR: 320, treeW: 160 }));
		const { result } = renderHook(() => usePaneSizes(true));
		expect(result.current.vars).toEqual({
			'--rail-l': '300px',
			'--rail-r': '320px',
			'--tree-w': '160px'
		});
	});

	it('studio role falls back per-field when a number is missing/wrong type', () => {
		localStorage.setItem(KEY, JSON.stringify({ railR: 300 })); // railL + treeW absent → defaults
		const { result } = renderHook(() => usePaneSizes(true));
		expect(result.current.vars).toEqual({
			'--rail-l': '250px',
			'--rail-r': '300px',
			'--tree-w': '200px'
		});
	});

	it('a divider drag updates the matching var and persists on pointerup', () => {
		const { result } = renderHook(() => usePaneSizes(true));

		act(() => result.current.startResize('left', reactDown(100)));
		act(() => {
			window.dispatchEvent(new MouseEvent('pointermove', { clientX: 140 }));
		});
		// 250 (start) + 40 (dx) = 290.
		expect(result.current.vars['--rail-l' as keyof typeof result.current.vars]).toBe('290px');

		act(() => {
			window.dispatchEvent(new MouseEvent('pointerup'));
		});
		// Persisted on release.
		expect(JSON.parse(localStorage.getItem(KEY)!).railL).toBe(290);

		// Listeners removed: a further move after pointerup does nothing.
		act(() => {
			window.dispatchEvent(new MouseEvent('pointermove', { clientX: 999 }));
		});
		expect(result.current.vars['--rail-l' as keyof typeof result.current.vars]).toBe('290px');
	});

	it('the right rail grows as its divider moves left (-dx)', () => {
		const { result } = renderHook(() => usePaneSizes(true));
		act(() => result.current.startResize('right', reactDown(200)));
		act(() => {
			window.dispatchEvent(new MouseEvent('pointermove', { clientX: 150 })); // dx -50
		});
		// 264 - (-50)?? right grows by -dx → 264 + 50 = 314.
		expect(result.current.vars['--rail-r' as keyof typeof result.current.vars]).toBe('314px');
	});

	it('drags the tree column too (covers the tree startVal branch)', () => {
		const { result } = renderHook(() => usePaneSizes(true));
		act(() => result.current.startResize('tree', reactDown(0) as ReactPointerEvent));
		act(() => {
			window.dispatchEvent(new MouseEvent('pointermove', { clientX: 30 }));
		});
		expect(result.current.vars['--tree-w' as keyof typeof result.current.vars]).toBe('230px');
	});

	it('all three edges resolve a start value', () => {
		const { result } = renderHook(() => usePaneSizes(true));
		// Sanity: starting a resize on each edge does not throw and persists on release.
		for (const edge of ['left', 'tree', 'right'] as Edge[]) {
			act(() => result.current.startResize(edge, reactDown(0)));
			act(() => {
				window.dispatchEvent(new MouseEvent('pointerup'));
			});
		}
		expect(localStorage.getItem(KEY)).toBeTruthy();
	});
});
