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
// leaking. The standalone Sparkline widget draws into a canvas the same way; see Sparkline.tsx.)
import { useCallback, useEffect, useRef } from 'react';
import { coreCellRects } from './cpuCoresMath';
import { sparklineBars, sparklinePoints } from './sparklineMath';
import { nextScroll, scrollAt, pixelScrollOffset, type ScrollClock } from './scrollClock';
import './Cpu.css';

type Props = {
	cores: number[][];
	smooth?: boolean;
	smoothDelay?: number;
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
	const displayed = useRef(props.cores);
	const scroll = useRef(0);
	const playback = useRef(false);
	const sample = useRef(props.cores);
	const clock = useRef<ScrollClock | null>(null);
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
		if (displayed.current.length === 0) return;

		const cs = getComputedStyle(canvas);
		const color = p.color || cs.getPropertyValue('--np-fg').trim() || FALLBACK_COLOR;
		const gapPx = parseFloat(cs.getPropertyValue('--np-cpu-core-gap'));
		const gap = (Number.isFinite(gapPx) ? gapPx : DEFAULT_GAP) * dpr;
		const colCount = p.cols && p.cols > 0 ? Math.round(p.cols) : displayed.current.length;
		const cells = coreCellRects(displayed.current.length, colCount, w, h, gap);
		const windowSlots = Math.max(1, Math.round(p.seconds));
		const lw = Math.max(1, (p.lineWidth || 1.5) * dpr);

		displayed.current.forEach((history, i) => {
			const cell = cells[i];
			if (!cell || cell.w <= 0 || cell.h <= 0) return;
			ctx.save();
			ctx.beginPath();
			ctx.rect(cell.x, cell.y, cell.w, cell.h);
			ctx.clip();
			const shift =
				playback.current && clock.current
					? pixelScrollOffset(clock.current, scroll.current, cell.w / windowSlots)
					: 0;
			if (p.histogram) {
				const bars = sparklineBars(
					history,
					cell.w,
					cell.h,
					0,
					100,
					p.barGap ?? 0,
					windowSlots,
					0,
					playback.current ? (p.smoothDelay ?? 1.5) : 0
				);
				ctx.fillStyle = color;
				for (const b of bars) ctx.fillRect(cell.x + b.x + shift, cell.y + b.y, b.w, b.h);
				ctx.restore();
				return;
			}
			const pts = sparklinePoints(
				history,
				cell.w,
				cell.h,
				0,
				100,
				windowSlots,
				0,
				playback.current ? (p.smoothDelay ?? 1.5) : 0
			);
			if (pts.length === 0) {
				ctx.restore();
				return;
			}
			if (p.fill) {
				ctx.fillStyle = color;
				ctx.globalAlpha = 0.18;
				ctx.beginPath();
				ctx.moveTo(cell.x, cell.y + cell.h);
				for (const [x, y] of pts) ctx.lineTo(cell.x + x + shift, cell.y + y);
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
				const px = cell.x + x + shift;
				const py = cell.y + y;
				if (j === 0) ctx.moveTo(px, py);
				else ctx.lineTo(px, py);
			});
			ctx.stroke();
			ctx.restore();
		});
	}, []);

	// Telemetry histories advance once per second. Scroll their recorded slots linearly
	// between arrivals; never interpolate values or animate a hidden/reduced-motion view.
	useEffect(() => {
		if (clock.current === null || sample.current !== props.cores) {
			clock.current = nextScroll(
				clock.current,
				performance.now(),
				sample.current.length === props.cores.length
			);
			sample.current = props.cores;
		}
		displayed.current = props.cores;
		let frame: number | null = null;
		const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
		const cancel = () => {
			if (frame !== null) cancelAnimationFrame(frame);
			frame = null;
		};
		const stop = () => {
			cancel();
			playback.current = false;
			scroll.current = 0;
			draw();
		};
		const start = clock.current;
		const animate = (now: number) => {
			scroll.current = scrollAt(start, now);
			draw();
			frame = scroll.current < 1 ? requestAnimationFrame(animate) : null;
		};
		if (
			props.smooth &&
			props.cores.some((history) => history.length > 1) &&
			!motion.matches &&
			document.visibilityState !== 'hidden'
		) {
			playback.current = true;
			animate(performance.now());
		} else stop();
		motion.addEventListener('change', stop);
		document.addEventListener('visibilitychange', stop);
		return () => {
			cancel();
			motion.removeEventListener('change', stop);
			document.removeEventListener('visibilitychange', stop);
		};
	}, [
		draw,
		props.cores,
		props.smooth,
		props.smoothDelay,
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
