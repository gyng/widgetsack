// useSplitters mixes pointer-drag glue (setPointerCapture / clientX-Y deltas) with REAL logic: the
// grid-track vs child-basis commit branch (setSplit), the zoom-scaled drag delta, the even-split
// double-click reset, and the WCAG keyboard nudge (axis + Shift step). We pass commitOp/mutateNoSave
// as spies and drive the handlers with synthetic pointer/keyboard events, then INVOKE the captured
// updater against a real grid/row monitor so the actual editHelpers math runs and we can assert the
// resulting tree (real behavior, not "was a fn called"). The pure geometry (resizeSplit) is also
// unit-tested directly in solve.test.ts; here we pin the wiring + branch selection around it.
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSplitters } from './useSplitters';
import type { Splitter } from '../../core/solve';
import { container, leaf, type MonitorLayout } from '../../core/layoutTree';
import { createWidget } from '../../core/widget';
import type { EditorState } from './types';

// A row container with two fr children A/B (the non-grid splitter case).
function rowMonitor(): MonitorLayout {
	const a = leaf(createWidget('text', 'A'), { fr: 1 });
	const b = leaf(createWidget('text', 'B'), { fr: 1 });
	return { root: container('row1', 'row', [a, b]), floating: [] };
}
// A grid container (the grid-track splitter case).
function gridMonitor(): MonitorLayout {
	const a = leaf(createWidget('text', 'A'));
	const b = leaf(createWidget('text', 'B'));
	return { root: container('grid1', 'grid', [a, b], { cols: 2, rows: 1 }), floating: [] };
}
function stateWith(monitor: MonitorLayout): EditorState {
	return { monitor } as EditorState;
}

// A non-grid (child-basis) splitter between A and B.
function rowSplitter(over: Partial<Splitter> = {}): Splitter {
	return {
		containerId: 'row1',
		axis: 'row',
		aId: 'A',
		bId: 'B',
		frA: 1,
		frB: 1,
		mainA: 100,
		mainB: 100,
		rect: { x: 0, y: 0, w: 8, h: 50 },
		...over
	};
}
// A grid-track splitter between columns 0 and 1.
function gridSplitter(): Splitter {
	return {
		containerId: 'grid1',
		axis: 'row',
		aId: 'A',
		bId: 'B',
		frA: 1,
		frB: 1,
		mainA: 100,
		mainB: 100,
		rect: { x: 0, y: 0, w: 8, h: 50 },
		track: { which: 'col', a: 0, b: 1 }
	};
}

// A synthetic pointer event with the bits the hook reads.
function ptr(over: Partial<Record<string, unknown>> = {}) {
	return {
		button: 0,
		clientX: 0,
		clientY: 0,
		pointerId: 1,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
		currentTarget: { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() },
		...over
	} as unknown as React.PointerEvent;
}

function setup(zoom = 1) {
	const commitOp = vi.fn<[(s: EditorState) => Partial<EditorState>], void>();
	const mutateNoSave = vi.fn<[(s: EditorState) => Partial<EditorState>], void>();
	const { result } = renderHook(() => useSplitters({ zoom, commitOp, mutateNoSave }));
	return { result, commitOp, mutateNoSave };
}

describe('pointer drag (down → move → up)', () => {
	it('captures the pointer on down and ignores non-primary buttons', () => {
		const { result } = setup();
		const e = ptr({ button: 1 }); // middle button → ignored
		result.current.onSplitDown(e, rowSplitter());
		expect(
			(e.currentTarget as unknown as { setPointerCapture: ReturnType<typeof vi.fn> })
				.setPointerCapture
		).not.toHaveBeenCalled();

		const e2 = ptr({ button: 0 });
		result.current.onSplitDown(e2, rowSplitter());
		expect(e2.preventDefault).toHaveBeenCalled();
		expect(
			(e2.currentTarget as unknown as { setPointerCapture: ReturnType<typeof vi.fn> })
				.setPointerCapture
		).toHaveBeenCalledWith(1);
	});

	it('move resizes LIVE (mutateNoSave, no commit) using a zoom-scaled delta on a child-basis splitter', () => {
		const { result, commitOp, mutateNoSave } = setup(2); // zoom 2 → screen delta halved in world px
		result.current.onSplitDown(ptr({ clientX: 0 }), rowSplitter());
		result.current.onSplitMove(ptr({ clientX: 40 })); // 40 screen px / zoom 2 = 20 world px
		expect(commitOp).not.toHaveBeenCalled();
		expect(mutateNoSave).toHaveBeenCalledTimes(1);
		// Run the captured updater against the real row monitor → A grows, B shrinks, fr sum preserved.
		const patch = mutateNoSave.mock.calls[0][0](stateWith(rowMonitor()));
		const root = (patch.monitor as MonitorLayout).root;
		const kids = (root as { children: { id: string; basis?: { fr: number } }[] }).children;
		const frA = kids.find((c) => c.id === 'A')!.basis!.fr;
		const frB = kids.find((c) => c.id === 'B')!.basis!.fr;
		expect(frA).toBeGreaterThan(frB); // dragging right widened A
		expect(Number((frA + frB).toFixed(3))).toBe(2); // combined fr conserved
	});

	it('a COL-axis move uses the clientY delta, and zoom 0 falls back to a 1:1 scale', () => {
		const { result, mutateNoSave } = setup(0); // zoom 0 → the `zoom || 1` guard scales by 1
		result.current.onSplitDown(
			ptr({ clientY: 0 }),
			rowSplitter({ axis: 'col', containerId: 'row1' })
		);
		result.current.onSplitMove(ptr({ clientY: 24 })); // vertical drag on a col splitter
		const patch = mutateNoSave.mock.calls[0][0](
			stateWith({
				root: container('row1', 'col', [
					leaf(createWidget('text', 'A'), { fr: 1 }),
					leaf(createWidget('text', 'B'), { fr: 1 })
				]),
				floating: []
			})
		);
		const kids = (
			(patch.monitor as MonitorLayout).root as {
				children: { id: string; basis?: { fr: number } }[];
			}
		).children;
		expect(kids.find((c) => c.id === 'A')!.basis!.fr).toBeGreaterThan(1); // dragging down widened A
	});

	it('move with no active drag is a no-op', () => {
		const { result, mutateNoSave } = setup();
		result.current.onSplitMove(ptr({ clientX: 40 }));
		expect(mutateNoSave).not.toHaveBeenCalled();
	});

	it('up COMMITS the final sizes, releases capture, and clears the drag', () => {
		const { result, commitOp } = setup();
		result.current.onSplitDown(ptr({ clientX: 0 }), rowSplitter());
		result.current.onSplitMove(ptr({ clientX: 30 }));
		const up = ptr({ clientX: 30 });
		result.current.onSplitUp(up);
		expect(commitOp).toHaveBeenCalledTimes(1);
		expect(
			(up.currentTarget as unknown as { releasePointerCapture: ReturnType<typeof vi.fn> })
				.releasePointerCapture
		).toHaveBeenCalledWith(1);
		// A second up is a no-op now the drag is cleared.
		result.current.onSplitUp(ptr());
		expect(commitOp).toHaveBeenCalledTimes(1);
	});

	it('a grid-track splitter drag commits via the GRID colFr branch', () => {
		const { result, commitOp } = setup();
		result.current.onSplitDown(ptr({ clientX: 0 }), gridSplitter());
		result.current.onSplitUp(ptr({ clientX: 25 }));
		expect(commitOp).toHaveBeenCalledTimes(1);
		const patch = commitOp.mock.calls[0][0](stateWith(gridMonitor()));
		const grid = (patch.monitor as MonitorLayout).root as { colFr?: number[] };
		expect(Array.isArray(grid.colFr)).toBe(true);
		expect(grid.colFr).toHaveLength(2);
		// Default deltas of 0 keep the tracks balanced; a non-empty weight array is what matters here.
		expect(grid.colFr!.every((w) => w > 0)).toBe(true);
	});
});

describe('onSplitReset (double-click → even pair)', () => {
	it('commits an even split that preserves the pair’s combined fr', () => {
		const { result, commitOp } = setup();
		result.current.onSplitReset(rowSplitter({ frA: 3, frB: 1 }));
		expect(commitOp).toHaveBeenCalledTimes(1);
		const patch = commitOp.mock.calls[0][0](stateWith(rowMonitor()));
		const kids = (
			(patch.monitor as MonitorLayout).root as {
				children: { id: string; basis?: { fr: number } }[];
			}
		).children;
		// (3 + 1) / 2 = 2 on each side.
		expect(kids.find((c) => c.id === 'A')!.basis!.fr).toBe(2);
		expect(kids.find((c) => c.id === 'B')!.basis!.fr).toBe(2);
	});
});

describe('onSplitKey (WCAG keyboard nudge)', () => {
	const key = (k: string, shift = false) =>
		({ key: k, shiftKey: shift, preventDefault: vi.fn() } as unknown as React.KeyboardEvent);
	// fr of child A after the n-th commit, run against a real row monitor.
	const frA = (commitOp: ReturnType<typeof setup>['commitOp'], call: number) => {
		const patch = commitOp.mock.calls[call][0](stateWith(rowMonitor()));
		const kids = (
			(patch.monitor as MonitorLayout).root as {
				children: { id: string; basis?: { fr: number } }[];
			}
		).children;
		return kids.find((c) => c.id === 'A')!.basis!.fr;
	};

	it('row axis: Shift+ArrowRight grows A, Shift+ArrowLeft shrinks A (direction mapping)', () => {
		// Use the Shift step (24px) so the nudge clears resizeSplit's 14px center-snap band.
		const { result, commitOp } = setup();
		const right = key('ArrowRight', true);
		result.current.onSplitKey(right, rowSplitter());
		expect(right.preventDefault).toHaveBeenCalled();
		expect(frA(commitOp, 0)).toBeGreaterThan(1);

		result.current.onSplitKey(key('ArrowLeft', true), rowSplitter());
		expect(frA(commitOp, 1)).toBeLessThan(1);
	});

	it('Shift takes a bigger step than the bare arrow', () => {
		const { result, commitOp } = setup();
		// Off-center mains so the bare 8px step also produces a (small) change rather than snapping.
		const sp = rowSplitter({ mainA: 320, mainB: 80 });
		result.current.onSplitKey(key('ArrowRight', false), sp);
		result.current.onSplitKey(key('ArrowRight', true), sp);
		expect(frA(commitOp, 1)).toBeGreaterThan(frA(commitOp, 0)); // Shift (24) > bare (8)
	});

	it('col axis uses ArrowDown (preventDefault + commit)', () => {
		const { result, commitOp } = setup();
		const down = key('ArrowDown', true);
		result.current.onSplitKey(down, rowSplitter({ axis: 'col' }));
		expect(down.preventDefault).toHaveBeenCalled();
		expect(commitOp).toHaveBeenCalledTimes(1);
	});

	it('col axis ArrowUp shrinks; row-axis ArrowUp/ArrowDown are ignored (wrong axis)', () => {
		const { result, commitOp } = setup();
		// col + ArrowUp → negative step → commit.
		result.current.onSplitKey(key('ArrowUp', true), rowSplitter({ axis: 'col' }));
		expect(commitOp).toHaveBeenCalledTimes(1);
		// row + ArrowUp → d stays 0 → ignored.
		const up = key('ArrowUp');
		result.current.onSplitKey(up, rowSplitter({ axis: 'row' }));
		expect(up.preventDefault).not.toHaveBeenCalled();
		expect(commitOp).toHaveBeenCalledTimes(1); // unchanged
	});

	it('an irrelevant key is ignored (no commit, no preventDefault)', () => {
		const { result, commitOp } = setup();
		const noop = key('Enter');
		result.current.onSplitKey(noop, rowSplitter());
		expect(noop.preventDefault).not.toHaveBeenCalled();
		expect(commitOp).not.toHaveBeenCalled();
	});

	it('a wrong-axis arrow on a COL splitter (ArrowLeft) is ignored', () => {
		const { result, commitOp } = setup();
		const left = key('ArrowLeft');
		result.current.onSplitKey(left, rowSplitter({ axis: 'col' }));
		expect(left.preventDefault).not.toHaveBeenCalled();
		expect(commitOp).not.toHaveBeenCalled();
	});
});
