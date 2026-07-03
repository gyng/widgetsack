// Resizable studio panes (item: drag the rail dividers). The three studio column widths live as CSS
// custom properties on the `.canvas` root (--rail-l left rail, --tree-w the designer structure tree,
// --rail-r right details rail); the stage fills what's left. This hook holds them in state, seeds
// from localStorage, exposes them as inline vars (overriding the CSS defaults), and drives a divider
// drag. Persisted per-machine (a UI pref, not part of the portable widgets.json). The drag math is
// pure (clampPane / applyDelta) and unit-tested in usePaneSizes.test.ts.
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent
} from 'react';

import { readJson, writeJson } from '../../../stores/persist';

export type Edge = 'left' | 'right' | 'tree';
export type PaneSizes = { railL: number; railR: number; treeW: number };

export const PANE_DEFAULTS: PaneSizes = { railL: 250, railR: 264, treeW: 200 };
const LIMITS: Record<Edge, [number, number]> = {
	left: [180, 520],
	right: [180, 520],
	tree: [120, 460]
};
const KEY = 'widgetsack.studio.panes';

/** Clamp a pane width to its edge's [min, max] (and round to a whole px). Pure. */
export function clampPane(edge: Edge, value: number): number {
	const [lo, hi] = LIMITS[edge];
	return Math.max(lo, Math.min(hi, Math.round(value)));
}

/** New sizes after dragging `edge` by `dx` px from `startVal` (the right rail grows leftward, so its
 * width increases as the divider moves left → `startVal - dx`). Other widths are untouched. Pure. */
export function applyDelta(sizes: PaneSizes, edge: Edge, startVal: number, dx: number): PaneSizes {
	if (edge === 'left') return { ...sizes, railL: clampPane('left', startVal + dx) };
	if (edge === 'tree') return { ...sizes, treeW: clampPane('tree', startVal + dx) };
	return { ...sizes, railR: clampPane('right', startVal - dx) };
}

function load(): PaneSizes {
	const o = readJson(KEY) as Partial<PaneSizes> | null;
	if (!o) return PANE_DEFAULTS;
	return {
		railL: clampPane('left', typeof o.railL === 'number' ? o.railL : PANE_DEFAULTS.railL),
		railR: clampPane('right', typeof o.railR === 'number' ? o.railR : PANE_DEFAULTS.railR),
		treeW: clampPane('tree', typeof o.treeW === 'number' ? o.treeW : PANE_DEFAULTS.treeW)
	};
}

export type PaneSizing = {
	vars: CSSProperties; // inline CSS custom properties for the `.canvas` root (studio only)
	startResize: (edge: Edge, e: PointerEvent) => void;
};

export function usePaneSizes(studio: boolean): PaneSizing {
	const [sizes, setSizes] = useState<PaneSizes>(() => (studio ? load() : PANE_DEFAULTS));
	// Mirror the latest sizes for the pointer handlers (startResize / onUp read it later, off-render).
	const sizesRef = useRef(sizes);
	useEffect(() => {
		sizesRef.current = sizes;
	});

	const startResize = useCallback((edge: Edge, e: PointerEvent) => {
		e.preventDefault();
		const s = sizesRef.current;
		const startVal = edge === 'left' ? s.railL : edge === 'tree' ? s.treeW : s.railR;
		const startX = e.clientX;
		const onMove = (ev: globalThis.PointerEvent) => {
			setSizes((cur) => applyDelta(cur, edge, startVal, ev.clientX - startX));
		};
		const onUp = () => {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			writeJson(KEY, sizesRef.current);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}, []);

	const vars: CSSProperties = studio
		? ({
				'--rail-l': `${sizes.railL}px`,
				'--rail-r': `${sizes.railR}px`,
				'--tree-w': `${sizes.treeW}px`
			} as CSSProperties)
		: {};

	return { vars, startResize };
}
