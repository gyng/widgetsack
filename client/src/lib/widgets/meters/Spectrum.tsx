// Self-sourcing audio spectrum meter (binds:'none'). Unlike the SVG meters it renders to a <canvas>,
// driven imperatively — at up to 60 fps with dozens of bars, re-running React reconciliation per
// frame (the Sparkline pattern) would be the wrong tool. It reads the spectrum source from context
// — the documented self-sourcing exception, like Cpu.tsx reads the telemetry hub — and never touches
// Tauri directly. The draw is PUSH-driven: it paints on each frame the source pushes (over the Tauri
// Channel), NOT in a requestAnimationFrame loop. That matters because the overlay is an always-on-top
// transparent window whose rAF the compositor can throttle, which would stall a pull-loop. Modes:
// 'bars' (frequency bars) and 'spectrogram' (scrolling heatmap). Pure draw math lives in spectrumMath.ts.
import { useContext, useEffect, useRef } from 'react';
import { SpectrumContext } from '../spectrumContext';
import type { SpectrumFrame } from '../../audio/source';
import {
	groupBands,
	magnitudeColor,
	pipPositions,
	spectrumBars,
	SPECTRUM_FMAX,
	SPECTRUM_FMIN
} from './spectrumMath';
import './Spectrum.css';

type Props = {
	mode?: 'bars' | 'spectrogram';
	bars?: number;
	gap?: number;
	color?: string;
	device?: string;
	scale?: string;
	pips?: boolean;
};

const FALLBACK_COLOR = 'rgb(119, 196, 211)';
// Decade gridline markers (Hz) for the frequency-pips overlay.
const PIP_FREQS = [100, 1000, 10000];
const PIP_LINE = 'rgba(255, 255, 255, 0.16)';
const PIP_TEXT = 'rgba(255, 255, 255, 0.5)';

export default function Spectrum({
	mode = 'bars',
	bars = 48,
	gap = 0.15,
	color,
	device = '',
	scale = 'log',
	pips = false
}: Props) {
	const source = useContext(SpectrumContext);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	// Live config read by the draw without re-subscribing the stream. `device`/`scale` are NOT here —
	// they're effect deps, so changing them re-acquires (the backend re-bins / re-inits accordingly).
	// Written in a commit effect (not during render) so the draw callbacks read the latest values.
	const cfg = useRef({ mode, bars, gap, color, pips });
	useEffect(() => {
		cfg.current = { mode, bars, gap, color, pips };
	});

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!source || !canvas) return;
		const release = source.acquire(device, scale);
		const ctx = canvas.getContext('2d');
		const linear = scale === 'linear';
		// Pip fractions are constant for this scale; recompute only when the effect re-runs.
		const pipList = pipPositions(PIP_FREQS, SPECTRUM_FMIN, SPECTRUM_FMAX, linear);

		// True right after a (re)size: the canvas is blank, so skip the spectrogram's self-scroll
		// (which would otherwise shift blank pixels in). Cleared after the first paint.
		let freshCanvas = true;

		const resolveColor = (): string => {
			if (cfg.current.color) return cfg.current.color;
			const accent = getComputedStyle(canvas).getPropertyValue('--np-accent').trim();
			return accent || FALLBACK_COLOR;
		};

		// Match the backing store to the displayed size × DPR so bars stay crisp on HiDPI.
		const fit = (): { w: number; h: number } => {
			const dpr = window.devicePixelRatio || 1;
			const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
			const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
			if (canvas.width !== w || canvas.height !== h) {
				canvas.width = w;
				canvas.height = h;
				freshCanvas = true; // resize wipes the canvas → rebuild the spectrogram from here
			}
			return { w, h };
		};

		// Vertical pips + labels for bars mode (frequency runs along x).
		const drawBarPips = (w: number, h: number): void => {
			if (!ctx || !cfg.current.pips || pipList.length === 0) return;
			const dpr = window.devicePixelRatio || 1;
			const t = Math.max(1, Math.round(dpr));
			ctx.textBaseline = 'bottom';
			ctx.font = `${Math.max(8, Math.round(9 * dpr))}px sans-serif`;
			for (const p of pipList) {
				const x = p.frac * w;
				ctx.fillStyle = PIP_LINE;
				ctx.fillRect(x, 0, t, h);
				ctx.fillStyle = PIP_TEXT;
				ctx.fillText(p.label, x + 2 * dpr, h - 2 * dpr);
			}
		};

		const drawBars = (frame: SpectrumFrame, w: number, h: number): void => {
			if (!ctx) return;
			ctx.clearRect(0, 0, w, h);
			const colorCss = resolveColor();
			// A faint baseline so an idle (silent) spectrum still reads as "a spectrum at rest" rather
			// than a blank, invisible box — and stays findable/selectable in the studio.
			const baseline = Math.max(1, Math.round(window.devicePixelRatio || 1));
			ctx.fillStyle = colorCss;
			ctx.globalAlpha = 0.25;
			ctx.fillRect(0, h - baseline, w, baseline);
			ctx.globalAlpha = 1;
			const display = groupBands(frame.bands, Math.max(1, Math.round(cfg.current.bars)));
			ctx.fillStyle = colorCss;
			for (const r of spectrumBars(display, w, h, cfg.current.gap))
				ctx.fillRect(r.x, r.y, r.w, r.h);
			drawBarPips(w, h); // gridlines + labels on top
		};

		const drawSpectrogramColumn = (frame: SpectrumFrame, w: number, h: number): void => {
			if (!ctx) return;
			// Scroll the existing image one pixel left, then paint the newest frame as the right column
			// — but not on a fresh canvas (there's nothing to scroll, and reading it would shift blanks).
			if (!freshCanvas) ctx.drawImage(canvas, -1, 0);
			const n = frame.bands.length;
			if (n > 0) {
				const x = w - 1;
				for (let i = 0; i < n; i++) {
					// Low frequencies at the bottom, high at the top.
					const yTop = Math.round(h - ((i + 1) / n) * h);
					const yBottom = Math.round(h - (i / n) * h);
					const [r, g, b] = magnitudeColor(frame.bands[i]);
					ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
					ctx.fillRect(x, yTop, 1, Math.max(1, yBottom - yTop));
				}
			}
			// Horizontal pips (no labels — they'd smear under the scroll). A full-width line is invariant
			// to the 1px horizontal shift, so redrawing it each frame keeps it crisp.
			if (cfg.current.pips && pipList.length > 0) {
				const t = Math.max(1, Math.round(window.devicePixelRatio || 1));
				ctx.fillStyle = PIP_LINE;
				for (const p of pipList) ctx.fillRect(0, h - p.frac * h, w, t);
			}
		};

		const render = (frame: SpectrumFrame): void => {
			if (!ctx) return;
			const { w, h } = fit();
			if (cfg.current.mode === 'spectrogram') drawSpectrogramColumn(frame, w, h);
			else drawBars(frame, w, h);
			freshCanvas = false;
		};

		// Push: paint on every frame the source delivers (immune to overlay rAF throttling).
		const offFrame = source.onFrame(render);
		const initial = source.latestFrame();
		if (initial) render(initial);
		// Repaint on resize (the canvas is wiped when its backing store changes; redraw the latest).
		const ro =
			typeof ResizeObserver !== 'undefined'
				? new ResizeObserver(() => {
						const f = source.latestFrame();
						if (f) render(f);
					})
				: null;
		ro?.observe(canvas);

		return () => {
			offFrame();
			ro?.disconnect();
			release();
		};
		// Re-subscribe when the source / device / scale changes; other config is read live (cfg).
	}, [source, device, scale]);

	return <canvas ref={canvasRef} className="np-spectrum" role="img" aria-label="audio spectrum" />;
}
