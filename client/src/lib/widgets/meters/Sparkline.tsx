// Presentational meter (molecule): renders a sensor's history ring buffer as a line, optionally
// filled, or as histogram bars — drawn into ONE <canvas>. It used to be SVG whose polyline/polygon
// points were rewritten every telemetry tick: the pattern CpuCoresCanvas documents as a WebView2
// native-memory leak (each re-rasterised SVG layer is never released; a transparent always-on-top
// overlay OOMs after hours). A canvas updates via its bitmap — fixed backing store, no re-raster —
// so this follows the same draw approach: pure geometry from sparklineMath, an imperative draw on
// data/config change + resize, backing store matched to the displayed size × DPR.
//
// STYLING: the wrapper keeps the `sparkline np-sparkline` classes and `data-part` / `data-mode`
// attributes so theme CSS can still size, position and tint it. Canvas content isn't DOM, so the
// colour is resolved from the wrapper's computed `color` — the config `color` inline, else the
// --np-accent token from Sparkline.css — which makes `currentColor`, `var()` and named colours all
// work (the ticker passes `currentColor`). Props/meta are unchanged from the SVG version.
import { useCallback, useEffect, useRef } from 'react';
import { sparklineBars, sparklinePoints } from './sparklineMath';
import './Sparkline.css';

type Props = {
	history?: number[];
	min?: number | null;
	max?: number | null;
	color?: string;
	fill?: boolean;
	// Histogram mode: draw value bars rising from the baseline instead of a line.
	histogram?: boolean;
	// Gap between histogram bars as a fraction of each slot (0 = bars touching). Defaults to a
	// standard 0.2 margin.
	barGap?: number;
	// Draw a baseline axis line under the histogram bars (default on; histogram mode only).
	axis?: boolean;
	// Rolling history window in SECONDS; the chart is right-anchored to this window.
	seconds?: number;
	// Line thickness in px (constant regardless of widget size, like the old non-scaling stroke).
	lineWidth?: number;
};

const FALLBACK_COLOR = 'rgb(119, 196, 211)';
const FILL_ALPHA = 0.18;

export default function Sparkline({
	history = [],
	min = null,
	max = null,
	color,
	fill = true,
	histogram = false,
	barGap = 0.2,
	axis = true,
	seconds = 60,
	lineWidth = 1.5
}: Props) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	// Latest props read by the draw without re-subscribing the ResizeObserver. Written in a commit
	// effect (not during render) — the draw only reads it later from the effects below.
	const propsRef = useRef({ history, min, max, fill, histogram, barGap, axis, seconds, lineWidth });
	useEffect(() => {
		propsRef.current = { history, min, max, fill, histogram, barGap, axis, seconds, lineWidth };
	});

	const draw = useCallback((): void => {
		const wrap = wrapRef.current;
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext('2d');
		if (!wrap || !canvas || !ctx) return;
		const p = propsRef.current;
		const dpr = window.devicePixelRatio || 1;

		// Match the backing store to the displayed size × DPR so lines stay crisp on HiDPI.
		const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
		const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		ctx.clearRect(0, 0, w, h);

		const paint = getComputedStyle(wrap).color || FALLBACK_COLOR;
		const windowSlots = Math.max(1, Math.round(p.seconds));

		if (p.histogram) {
			const bars = sparklineBars(p.history, w, h, p.min, p.max, p.barGap, windowSlots);
			ctx.fillStyle = paint;
			for (const b of bars) ctx.fillRect(b.x, b.y, b.w, b.h);
			// Baseline axis: a thin line at the bottom the bars rise from (default on).
			if (p.axis) {
				const t = Math.max(1, Math.round(dpr));
				ctx.fillRect(0, h - t, w, t);
			}
			return;
		}

		const pts = sparklinePoints(p.history, w, h, p.min, p.max, windowSlots);
		if (pts.length === 0) return;
		if (p.fill) {
			ctx.fillStyle = paint;
			ctx.globalAlpha = FILL_ALPHA;
			ctx.beginPath();
			ctx.moveTo(0, h);
			for (const [x, y] of pts) ctx.lineTo(x, y);
			ctx.lineTo(w, h);
			ctx.closePath();
			ctx.fill();
			ctx.globalAlpha = 1;
		}
		ctx.strokeStyle = paint;
		ctx.lineWidth = Math.max(1, p.lineWidth * dpr);
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		ctx.beginPath();
		pts.forEach(([x, y], i) => {
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		});
		ctx.stroke();
	}, []);

	// Redraw whenever the data or any draw-affecting config changes (history is a new array each tick;
	// `color` changes the wrapper's computed colour the draw reads).
	useEffect(() => {
		draw();
	}, [draw, history, min, max, color, fill, histogram, barGap, axis, seconds, lineWidth]);

	// Repaint on resize (the canvas is wiped when its backing store changes).
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => draw());
		ro.observe(canvas);
		return () => ro.disconnect();
	}, [draw]);

	return (
		<div
			ref={wrapRef}
			className="sparkline np-sparkline"
			data-part="sparkline"
			data-mode={histogram ? 'histogram' : 'line'}
			role="img"
			aria-label="history"
			style={color ? { color } : undefined}
		>
			<canvas ref={canvasRef} className="np-sparkline-canvas" data-part="chart" />
		</div>
	);
}
