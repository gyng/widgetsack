// useMeasuredRects — the CSS-layout pivot's replacement for solveMonitor's output. It measures the
// rendered FlowNode DOM (every [data-id] under `worldRef`) into a `Solved` map in LOGICAL/layout
// coords, so the editor + click-through keep consuming the same Map<id,Rect> they got from the
// solver — only the SOURCE changes (browser layout, read back via getBoundingClientRect).
//
// Returns both the map as state (re-renders overlays when geometry changes, deduped to avoid churn)
// and a synchronous `measuredRef` for the drag/hit-test callbacks that read the map mid-gesture.
//
// Note: happy-dom returns zero rects, so this hook is exercised only at runtime/Playwright; the pure
// conversion it relies on (screenRectToLayout) is unit-tested in measureMath.test.ts.

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Rect } from '../../core/layout';
import type { Solved } from '../../core/solve';
import { screenRectToLayout } from '../../core/measureMath';

type Args = {
	worldRef: RefObject<HTMLElement | null>;
	zoom: number;
	// Re-measure when any of these change identity (monitor tree, work area, zoom, pan, edit mode).
	deps: unknown[];
	// When false the hook is inert (no observers, empty map) — used to keep it off the role that
	// still renders via the solver during the staged migration.
	enabled?: boolean;
};

const rectEq = (a: Rect, b: Rect): boolean =>
	a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

function sameMap(a: Solved, b: Solved): boolean {
	if (a.size !== b.size) return false;
	for (const [k, v] of a) {
		const o = b.get(k);
		if (!o || !rectEq(v, o)) return false;
	}
	return true;
}

export function useMeasuredRects({ worldRef, zoom, deps, enabled = true }: Args): {
	measured: Solved;
	measuredRef: RefObject<Solved>;
} {
	const [measured, setMeasured] = useState<Solved>(() => new Map());
	const measuredRef = useRef<Solved>(measured);

	const measure = useCallback(() => {
		const world = worldRef.current;
		if (!world) return;
		const w0 = world.getBoundingClientRect();
		const next: Solved = new Map();
		world.querySelectorAll<HTMLElement>('[data-id]').forEach((el) => {
			const id = el.getAttribute('data-id');
			if (id) next.set(id, screenRectToLayout(el.getBoundingClientRect(), w0, zoom));
		});
		if (sameMap(measuredRef.current, next)) return; // no geometry change → no churn
		measuredRef.current = next;
		setMeasured(next);
	}, [worldRef, zoom]);

	useLayoutEffect(() => {
		if (!enabled) return;
		const world = worldRef.current;
		if (!world) return;
		const ro = new ResizeObserver(() => measure());
		const observeAll = () => {
			ro.disconnect();
			ro.observe(world);
			world.querySelectorAll('[data-id]').forEach((el) => ro.observe(el));
		};
		observeAll();
		measure();
		// Subtree changes (add/remove widgets, style edits) → re-observe the new set + re-measure.
		const mo = new MutationObserver(() => {
			observeAll();
			measure();
		});
		mo.observe(world, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['style', 'class', 'data-id']
		});
		return () => {
			ro.disconnect();
			mo.disconnect();
		};
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [measure, enabled, ...deps]);

	return { measured, measuredRef };
}
