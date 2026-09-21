// useMeasuredRects — the CSS-layout pivot's replacement for solveMonitor's output. It measures the
// rendered FlowNode DOM (every [data-id] under `worldRef`) into a `Solved` map in LOGICAL/layout
// coords, so the editor + click-through keep consuming the same Map<id,Rect> they got from the
// solver — only the SOURCE changes (browser layout, read back via getBoundingClientRect).
//
// Returns both the map as state (re-renders overlays when geometry changes, deduped to avoid churn)
// and a synchronous `measuredRef` for the drag/hit-test callbacks that read the map mid-gesture.
//
// Triggers (why the deps are what they are):
//  • a ResizeObserver on the world + every [data-id] catches size changes (a sibling growing moves
//    its neighbours: the neighbour's own RO won't fire, but the sibling's does and measure() re-reads
//    EVERYTHING, so positions follow);
//  • a MutationObserver catches added/removed nodes (childList: a new widget/container needs
//    observing + measuring) and style/class/data-id attribute writes ON a [data-id] element (a
//    basis / pad / hidden-ids change that alters layout without a size change on the observed set).
//    Attribute churn INSIDE a widget (a meter's own class/style animation) is ignored: it can't move
//    a slot, and if it resizes one the RO reports it. Only childList records re-run observeAll —
//    an attribute write never changes the observed element set.
//  • `deps` (the caller's) cover what neither observer can see: the work area / stage size and the
//    zoom (measure converts screen px → layout px by zoom). The monitor tree itself is NOT a dep —
//    every tree edit lands in the DOM as a childList or [data-id] attribute mutation, which the
//    observer already turns into a measure; keying the effect on it too tore down + rebuilt both
//    observers and re-measured synchronously on every commit (twice per edit).
//  • measure() is coalesced through requestAnimationFrame: a commit that changes several slots
//    yields one RO batch + several MO records in the same frame; one measure per frame is enough
//    (rAF runs after layout, so it also reads the settled geometry).
//
// Note: happy-dom returns zero rects, so this hook is exercised only at runtime/Playwright (it is
// coverage-excluded — see vite.config.ts); the pure conversion it relies on (screenRectToLayout) is
// unit-tested in measureMath.test.ts.

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Rect } from '../../core/layout';
import type { Solved } from '../../core/solve';
import { screenRectToLayout } from '../../core/measureMath';

type Args = {
	worldRef: RefObject<HTMLElement | null>;
	zoom: number;
	// Re-measure (and re-arm the observers) when any of these change identity: the work area /
	// stage box. Tree edits are NOT needed here — the MutationObserver covers them (see above).
	deps: unknown[];
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

export function useMeasuredRects({ worldRef, zoom, deps }: Args): {
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
		const world = worldRef.current;
		if (!world) return;
		// One measure per animation frame, however many observer callbacks land in it.
		let raf = 0;
		const schedule = () => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				measure();
			});
		};
		const ro = new ResizeObserver(schedule);
		const observeAll = () => {
			ro.disconnect();
			ro.observe(world);
			world.querySelectorAll('[data-id]').forEach((el) => ro.observe(el));
		};
		observeAll();
		measure(); // synchronous first read (before paint) so the first render has rects
		const mo = new MutationObserver((records) => {
			let structural = false;
			let relevant = false;
			for (const r of records) {
				if (r.type === 'childList') {
					structural = true;
					relevant = true;
				} else if ((r.target as Element).hasAttribute?.('data-id')) {
					relevant = true; // an attribute write on a slot itself (style/class/data-id)
				}
				// else: attribute churn inside a widget — not a layout slot; the RO covers any resize.
			}
			if (!relevant) return;
			if (structural) observeAll(); // only added/removed nodes change the observed set
			schedule();
		});
		mo.observe(world, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['style', 'class', 'data-id']
		});
		return () => {
			if (raf) cancelAnimationFrame(raf);
			ro.disconnect();
			mo.disconnect();
		};
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [measure, ...deps]);

	return { measured, measuredRef };
}
