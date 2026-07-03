// The per-core CPU grid drawn into ONE <canvas> instead of N SVG <Sparkline>s. SVG sparklines that
// rewrite their points every telemetry tick make WebView2 re-rasterize a fresh layer each second and
// never release it — at ~16 cores that's a multi-GB/hour native leak that OOMs the overlay (a transparent
// always-on-top surface is worst-case). A single canvas updates via its bitmap (no re-raster, fixed
// backing store), exactly like the leak-free Spectrum meter. Self-contained imperative draw; the cell
// layout is the pure, tested coreCellRects; the line/bar geometry reuses sparklineMath.
//
// STYLING: colour resolves from the `color` config or the `--np-fg` token; spacing from
// `--np-cpu-core-gap`; `lineWidth`/`fill`/`histogram` from config. (Canvas content isn't DOM, so theme
// CSS can't target individual lines the way it could the SVG `data-part`s — that's the trade for not
// leaking. The standalone Sparkline widget stays SVG and fully stylable.)
import { useCallback, useEffect, useRef } from 'react';
import { coreCellRects } from './cpuCoresMath';
import { sparklineBars, sparklinePoints } from './sparklineMath';
import './Cpu.css';

type Props = {
	cores: number[][];
	cols: number; // 0 / unset → one column per core (a single full-width row)
	color?: string;
	seconds: number;
	histogram: boolean;
	lineWidth: number;
	fill: boolean;
	barGap?: number;
};

const FALLBACK_COLOR = 'rgb(255, 255, 255)';
const DEFAULT_GAP = 4;

export default function CpuCoresCanvas(props: Props) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	// Latest props read by the draw without re-subscribing the ResizeObserver. Written in a commit
	// effect (not during render) — the draw only reads it later from the ResizeObserver / telemetry tick.
	const propsRef = useRef(props);
	useEffect(() => {
		propsRef.current = props;
	});

	const draw = useCallback((): void => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext('2d');
		if (!canvas || !ctx) return;
		const p = propsRef.current;
		const dpr = window.devicePixelRatio || 1;

		// Match the backing store to the displayed size × DPR so lines stay crisp on HiDPI (Spectrum pattern).
		const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
		const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		ctx.clearRect(0, 0, w, h);
		if (p.cores.length === 0) return;

		const cs = getComputedStyle(canvas);
		const color = p.color || cs.getPropertyValue('--np-fg').trim() || FALLBACK_COLOR;
		const gapPx = parseFloat(cs.getPropertyValue('--np-cpu-core-gap'));
		const gap = (Number.isFinite(gapPx) ? gapPx : DEFAULT_GAP) * dpr;
		const colCount = p.cols && p.cols > 0 ? Math.round(p.cols) : p.cores.length;
		const cells = coreCellRects(p.cores.length, colCount, w, h, gap);
		const windowSlots = Math.max(1, Math.round(p.seconds));
		const lw = Math.max(1, (p.lineWidth || 1.5) * dpr);

		p.cores.forEach((history, i) => {
			const cell = cells[i];
			if (!cell || cell.w <= 0 || cell.h <= 0) return;
			if (p.histogram) {
				const bars = sparklineBars(history, cell.w, cell.h, 0, 100, p.barGap ?? 0, windowSlots);
				ctx.fillStyle = color;
				for (const b of bars) ctx.fillRect(cell.x + b.x, cell.y + b.y, b.w, b.h);
				return;
			}
			const pts = sparklinePoints(history, cell.w, cell.h, 0, 100, windowSlots);
			if (pts.length === 0) return;
			if (p.fill) {
				ctx.fillStyle = color;
				ctx.globalAlpha = 0.18;
				ctx.beginPath();
				ctx.moveTo(cell.x, cell.y + cell.h);
				for (const [x, y] of pts) ctx.lineTo(cell.x + x, cell.y + y);
				ctx.lineTo(cell.x + cell.w, cell.y + cell.h);
				ctx.closePath();
				ctx.fill();
				ctx.globalAlpha = 1;
			}
			ctx.strokeStyle = color;
			ctx.lineWidth = lw;
			ctx.lineJoin = 'round';
			ctx.lineCap = 'round';
			ctx.beginPath();
			pts.forEach(([x, y], j) => {
				const px = cell.x + x;
				const py = cell.y + y;
				if (j === 0) ctx.moveTo(px, py);
				else ctx.lineTo(px, py);
			});
			ctx.stroke();
		});
	}, []);

	// Redraw whenever the data or any draw-affecting config changes (the cores array is new each tick).
	useEffect(() => {
		draw();
	}, [
		draw,
		props.cores,
		props.cols,
		props.color,
		props.seconds,
		props.histogram,
		props.lineWidth,
		props.fill,
		props.barGap
	]);

	// Repaint on resize (the canvas is wiped when its backing store changes).
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => draw());
		ro.observe(canvas);
		return () => ro.disconnect();
	}, [draw]);

	// The grid is laid out INSIDE the canvas bitmap (coreCellRects), so the column count isn't otherwise
	// observable in the DOM — surface it for inspection/tests. Mirrors the draw's colCount (line ~58).
	const colCount = props.cols && props.cols > 0 ? Math.round(props.cols) : props.cores.length;
	return (
		<canvas
			ref={canvasRef}
			className="np-cpu-cores-canvas"
			role="img"
			aria-label="CPU per-core usage"
			data-cols={colCount}
		/>
	);
}
