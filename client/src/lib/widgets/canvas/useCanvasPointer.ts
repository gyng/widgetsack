// Canvas pointer interactions (item 3 marquee + Figma-style pan). A left-drag on empty canvas
// rubber-bands a multi-selection; a middle-drag or Space+drag pans the view. The window
// mousemove/mouseup listeners are attached imperatively on mousedown and removed on mouseup
// (mirrors the Svelte handlers exactly), with all transient bookkeeping in refs.
import { useCallback, useRef, useState } from 'react';
import '../../core/controls.defaults';
import {
	listControls,
	matchPointer,
	mergeOverrides,
	type ControlContext,
	type ControlOverrides,
	type PointerGesture
} from '../../core/controls';
import type { Rect } from '../../core/layout';
import { rectsIntersect } from '../../core/geometry';
import type { Renderable } from '../../core/solve';
import type { Pan } from './useZoomFit';

export type CanvasPointerDeps = {
	editMode: boolean;
	studio: boolean;
	overrides: () => ControlOverrides; // live remaps (empty until Phase 4)
	spaceDown: () => boolean; // read latest (held in a ref by useKeyboard)
	pan: () => Pan; // read latest pan/zoom
	setPan: React.Dispatch<React.SetStateAction<Pan>>;
	canvasRef: React.RefObject<HTMLDivElement | null>;
	renderables: () => Renderable[]; // read latest
	selectedIds: () => string[]; // read latest
	// Set the full marquee selection (ids) + the primary. The reducer's setSelectedIds is
	// authoritative — it writes selectedIds AND selectedId together, so the Svelte lastPrimary
	// "already-synced" dance isn't needed (there's no selectedId→selectedIds reactive to fight).
	setSelection: (ids: string[], primary: string | null) => void;
	clearSelection: () => void;
};

export type CanvasPointer = {
	marquee: Rect | null;
	panning: boolean;
	onCanvasMouseDown: (event: React.MouseEvent) => void;
};

/**
 * The widgets a marquee `box` (world coords) selects: ANY renderable it intersects — floating AND
 * in-flow. `additive` (Shift) merges into `currentIds`; otherwise it replaces. Group descendants
 * resolve to their group via `selectId` and the Set de-dups them; primary = last added. Pure.
 */
export function marqueeSelection(
	renderables: Renderable[],
	box: Rect,
	additive: boolean,
	currentIds: string[]
): { ids: string[]; primary: string | null } {
	const ids = new Set(additive ? currentIds : []);
	for (const r of renderables) if (rectsIntersect(r.rect, box)) ids.add(r.selectId);
	const list = [...ids];
	return { ids: list, primary: list[list.length - 1] ?? null };
}

export function useCanvasPointer(deps: CanvasPointerDeps): CanvasPointer {
	const [marquee, setMarquee] = useState<Rect | null>(null);
	const [panning, setPanning] = useState(false);

	const marqueeStart = useRef<{ x: number; y: number } | null>(null);
	const marqueeAdditive = useRef(false);
	const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
	// The live marquee rect, tracked in a ref (written by the mousedown/mousemove handlers alongside
	// setMarquee) so onMarqueeUp reads the final rect without touching the ref during render.
	const marqueeCurrent = useRef<Rect | null>(null);

	// canvas-relative coords (undo the rail inset).
	const toCanvas = useCallback(
		(x: number, y: number): { x: number; y: number } => {
			const el = deps.canvasRef.current;
			if (!el) return { x, y };
			const r = el.getBoundingClientRect();
			return { x: x - r.left, y: y - r.top };
		},
		[deps.canvasRef]
	);

	// canvas-space → world-space (undo pan + zoom); world is where solved/renderable rects live.
	const canvasToWorld = useCallback(
		(cx: number, cy: number): { x: number; y: number } => {
			const p = deps.pan();
			return { x: (cx - p.panX) / p.zoom, y: (cy - p.panY) / p.zoom };
		},
		[deps]
	);

	// --- pan (margin-drag, middle-drag, or Space+drag) ---
	const onPanMove = useCallback(
		(event: MouseEvent) => {
			const ps = panStart.current;
			if (!ps) return;
			deps.setPan((p) => ({
				...p,
				panX: ps.panX + (event.clientX - ps.x),
				panY: ps.panY + (event.clientY - ps.y)
			}));
		},
		[deps]
	);
	// Named function expression so the removeEventListener can reference the handler via its own
	// in-scope name (the same fn object addEventListener registered) instead of the outer const —
	// which the compiler would flag as "accessed before it is declared".
	const onPanUp = useCallback(
		function onPanUp() {
			window.removeEventListener('mousemove', onPanMove);
			window.removeEventListener('mouseup', onPanUp);
			panStart.current = null;
			setPanning(false);
		},
		[onPanMove]
	);
	const startPan = useCallback(
		(event: React.MouseEvent) => {
			const p = deps.pan();
			panStart.current = { x: event.clientX, y: event.clientY, panX: p.panX, panY: p.panY };
			setPanning(true);
			window.addEventListener('mousemove', onPanMove);
			window.addEventListener('mouseup', onPanUp);
		},
		[deps, onPanMove, onPanUp]
	);

	// --- marquee ---
	const onMarqueeMove = useCallback(
		(event: MouseEvent) => {
			const start = marqueeStart.current;
			if (!start) return;
			const p = toCanvas(event.clientX, event.clientY);
			const rect: Rect = {
				x: Math.min(p.x, start.x),
				y: Math.min(p.y, start.y),
				w: Math.abs(p.x - start.x),
				h: Math.abs(p.y - start.y)
			};
			marqueeCurrent.current = rect; // keep the ref in step with state (both set here, off-render)
			setMarquee(rect);
		},
		[toCanvas]
	);
	// Named function expression (see onPanUp) so removeEventListener can reference the handler itself.
	const onMarqueeUp = useCallback(
		function onMarqueeUp() {
			window.removeEventListener('mousemove', onMarqueeMove);
			window.removeEventListener('mouseup', onMarqueeUp);
			const m = marqueeCurrent.current;
			setMarquee(null);
			marqueeStart.current = null;
			marqueeCurrent.current = null;
			if (!m || (m.w < 3 && m.h < 3)) return; // a click, not a drag → leave selection as cleared
			const a = canvasToWorld(m.x, m.y);
			const b = canvasToWorld(m.x + m.w, m.y + m.h);
			const box: Rect = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
			const { ids, primary } = marqueeSelection(
				deps.renderables(),
				box,
				marqueeAdditive.current,
				deps.selectedIds()
			);
			deps.setSelection(ids, primary);
		},
		[onMarqueeMove, canvasToWorld, deps]
	);

	const onCanvasMouseDown = useCallback(
		(event: React.MouseEvent) => {
			if (!deps.editMode) return;
			const t = event.target as HTMLElement | null;
			const onCanvas = !!t?.classList.contains('world') || !!t?.classList.contains('canvas');
			// Resolve the gesture against the registry (pan vs marquee, honoring remaps) instead of a
			// hard-coded button/Space branch. Widget presses stopPropagation in WidgetHost, so reaching
			// here means an empty-canvas / chrome press.
			const gesture: PointerGesture = {
				button: event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left',
				kind: 'drag',
				target: onCanvas ? 'canvas' : 'any',
				ctrl: event.ctrlKey,
				shift: event.shiftKey,
				alt: event.altKey,
				meta: event.metaKey,
				spaceHeld: deps.spaceDown()
			};
			const ctx: ControlContext = {
				scope: 'studio',
				studio: deps.studio,
				editMode: deps.editMode,
				menuOpen: false,
				dirty: false,
				hasSelection: false,
				spaceDown: deps.spaceDown(),
				panning: false,
				previewing: false,
				pointerTarget: gesture.target
			};
			const hit = matchPointer(gesture, mergeOverrides(listControls(), deps.overrides()), ctx);
			if (!hit) return;
			if (hit.id === 'studio.panDrag') {
				event.preventDefault();
				startPan(event);
				return;
			}
			if (hit.id === 'studio.marquee' || hit.id === 'studio.marqueeAdd') {
				if (!onCanvas) return; // marquee only rubber-bands on the empty canvas/world
				const additive = hit.id === 'studio.marqueeAdd';
				const p = toCanvas(event.clientX, event.clientY);
				marqueeStart.current = p;
				const rect: Rect = { x: p.x, y: p.y, w: 0, h: 0 };
				marqueeCurrent.current = rect; // seed the ref so a click (no move) reads {w:0,h:0}
				setMarquee(rect);
				marqueeAdditive.current = additive;
				if (!additive) deps.clearSelection();
				window.addEventListener('mousemove', onMarqueeMove);
				window.addEventListener('mouseup', onMarqueeUp);
			}
		},
		[deps, startPan, toCanvas, onMarqueeMove, onMarqueeUp]
	);

	return { marquee, panning, onCanvasMouseDown };
}
