// Studio zoom-to-fit (item 1 / item 6): the flow tree is solved into the REAL monitor work area,
// then a "world" layer of that size is scaled + panned to fit the stage. `zoom`/`panX`/`panY`
// drive the world transform AND the drag-coordinate math; in the overlay they stay 1/0/0 (no
// transform). Auto-fit runs only AFTER a real measure, once per `${myMonitor}:${w}x${h}` key.
import { useCallback, useEffect, useRef, useState } from 'react';
import '../../core/controls.defaults';
import {
	listControls,
	matchWheel,
	mergeOverrides,
	type ControlContext,
	type ControlOverrides
} from '../../core/controls';

export type Pan = { panX: number; panY: number; zoom: number };

const NO_OVERRIDES = (): ControlOverrides => ({});

export type ZoomFit = Pan & {
	setPan: React.Dispatch<React.SetStateAction<Pan>>;
	fit: () => void;
	/** Zoom + pan so `rect` (world coords, e.g. the content or selection bounding box) fills the
	 *  stage with some breathing room — capped at 4× so a lone tiny widget doesn't blow up to a blur. */
	fitRect: (rect: { x: number; y: number; w: number; h: number }) => void;
};

/** The bounding box of `rects` (null when there are none) — for zoom-to-content / selection. Pure. */
export function boundingBox(
	rects: { x: number; y: number; w: number; h: number }[]
): { x: number; y: number; w: number; h: number } | null {
	if (!rects.length) return null;
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const r of rects) {
		x0 = Math.min(x0, r.x);
		y0 = Math.min(y0, r.y);
		x1 = Math.max(x1, r.x + r.w);
		y1 = Math.max(y1, r.y + r.h);
	}
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function useZoomFit(opts: {
	studio: boolean;
	myMonitor: string;
	monSize: { w: number; h: number };
	stageW: number;
	stageH: number;
	canvasRef: React.RefObject<HTMLDivElement | null>;
	overrides?: () => ControlOverrides; // live remaps (empty until Phase 4)
}): ZoomFit {
	const { studio, myMonitor, monSize, stageW, stageH, canvasRef } = opts;
	const [pan, setPan] = useState<Pan>({ panX: 0, panY: 0, zoom: 1 });
	// Read the latest overrides without re-subscribing the native wheel listener (its effect deps stay
	// [studio, canvasRef]); a new overrides fn each render just updates the ref (in a commit effect —
	// the wheel listener reads it later).
	const overridesRef = useRef(opts.overrides ?? NO_OVERRIDES);
	useEffect(() => {
		overridesRef.current = opts.overrides ?? NO_OVERRIDES;
	});

	// fit() reads the latest sizes via a ref so it's a stable callback (used by the Fit button + the
	// auto-fit effect) without re-subscribing. Mirrored in a commit effect declared BEFORE the auto-fit
	// effect below, so sizes.current is fresh by the time that effect calls fit().
	const sizes = useRef({ monSize, stageW, stageH });
	useEffect(() => {
		sizes.current = { monSize, stageW, stageH };
	});

	const fit = useCallback(() => {
		const { monSize: m, stageW, stageH } = sizes.current;
		// A section switch can change the canvas inset in the same commit that requests fit().
		// ResizeObserver updates stageW/H later; measure the committed stage now so the new
		// widget-designer rail cannot leave the fitted world clipped at its sides.
		const sw = canvasRef.current?.clientWidth || stageW;
		const sh = canvasRef.current?.clientHeight || stageH;
		if (!m.w || !m.h || !sw || !sh) return;
		const zoom = Math.min(sw / m.w, sh / m.h) * 0.95;
		setPan({ zoom, panX: (sw - m.w * zoom) / 2, panY: (sh - m.h * zoom) / 2 });
	}, [canvasRef]);

	const fitRect = useCallback(
		(rect: { x: number; y: number; w: number; h: number }) => {
			const { stageW, stageH } = sizes.current;
			const sw = canvasRef.current?.clientWidth || stageW;
			const sh = canvasRef.current?.clientHeight || stageH;
			if (!sw || !sh || rect.w <= 0 || rect.h <= 0) return;
			// 24px of stage padding around the box; never zoom past 4× (the wheel's ceiling).
			const pad = 24;
			const zoom = Math.min(4, (sw - pad * 2) / rect.w, (sh - pad * 2) / rect.h);
			const cx = rect.x + rect.w / 2;
			const cy = rect.y + rect.h / 2;
			setPan({ zoom, panX: sw / 2 - cx * zoom, panY: sh / 2 - cy * zoom });
		},
		[canvasRef]
	);

	// Auto-fit on first measure and whenever the edited monitor changes (not on manual zoom).
	const lastFitKey = useRef('');
	useEffect(() => {
		if (!(studio && stageW > 0 && stageH > 0 && monSize.w > 0)) return;
		const key = `${myMonitor}:${monSize.w}x${monSize.h}`;
		if (key !== lastFitKey.current) {
			lastFitKey.current = key;
			fit();
		}
	}, [studio, stageW, stageH, monSize.w, monSize.h, myMonitor, fit]);

	// Zoom toward the cursor on wheel (studio only). Mirrors Svelte's onWheel exactly. Attached as a
	// NATIVE non-passive listener so event.preventDefault() works — React's synthetic onWheel is
	// registered passively at the root (React 17+), where preventDefault would no-op/warn.
	useEffect(() => {
		const el = canvasRef.current;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			// Wheel over a docked rail / toolbar scrolls THAT panel — don't hijack it to zoom the stage.
			// (The rails are DOM descendants of `.canvas`, so their wheel events bubble to this listener.)
			const target = event.target as HTMLElement | null;
			if (
				target?.closest(
					'.outline, .inspector, .studio-bar, .theme-editor, .powerbar, .nav-rail, .rail-panel, .designer-list'
				)
			)
				return;
			// Gate on the registry's wheel control (studio-only by default; remappable/disable-able).
			const ctx: ControlContext = {
				scope: 'studio',
				studio,
				editMode: studio,
				menuOpen: false,
				dirty: false,
				hasSelection: false,
				spaceDown: false,
				panning: false,
				previewing: false
			};
			const hit = matchWheel(
				{ ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey },
				mergeOverrides(listControls(), overridesRef.current()),
				ctx
			);
			if (hit?.id !== 'studio.zoom') return;
			event.preventDefault();
			const r = el.getBoundingClientRect();
			const cx = event.clientX - r.left;
			const cy = event.clientY - r.top;
			setPan((p) => {
				const wx = (cx - p.panX) / p.zoom;
				const wy = (cy - p.panY) / p.zoom;
				const next = Math.min(4, Math.max(0.05, p.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
				return { zoom: next, panX: cx - wx * next, panY: cy - wy * next };
			});
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	}, [studio, canvasRef]);

	return { ...pan, setPan, fit, fitRect };
}
