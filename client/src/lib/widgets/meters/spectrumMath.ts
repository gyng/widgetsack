// Pure spectrum / spectrogram draw math, extracted so it is unit-testable without a canvas
// (AGENTS.md §4). Bands arrive already normalised to 0..1 from the backend FFT (audio.rs), low →
// high frequency, log- or linear-spaced (the backend's `scale`).

// The frequency range the backend's bands span — MIRRORS FMIN_HZ / FMAX_HZ in widgetsack/src/audio.rs.
// Used to place frequency pips so they line up with the bars under both scales.
export const SPECTRUM_FMIN = 30;
export const SPECTRUM_FMAX = 16000;

export type Bar = { x: number; y: number; w: number; h: number };

/** Max-pool `bands` down to `count` groups, preserving the log spacing the backend produced. When
 * `count >= bands.length` the bands pass through unchanged. Peak (not mean) per group keeps narrow
 * tones visible, matching the backend's per-band peak aggregation. */
export function groupBands(bands: number[], count: number): number[] {
	if (count <= 0 || bands.length === 0) return [];
	if (count >= bands.length) return bands.slice();
	const out = Array.from({ length: count }, () => 0);
	for (let i = 0; i < bands.length; i++) {
		const g = Math.min(count - 1, Math.floor((i * count) / bands.length));
		if (bands[i] > out[g]) out[g] = bands[i];
	}
	return out;
}

/** Map 0..1 band magnitudes to canvas-space bars rising from the bottom (`height`). `gap` (0..1) is
 * the fractional spacing between adjacent bars. Heights clamp to [0, height]; values clamp to 0..1. */
export function spectrumBars(bands: number[], width: number, height: number, gap = 0.15): Bar[] {
	const n = bands.length;
	if (n === 0 || width <= 0 || height <= 0) return [];
	const slot = width / n;
	const w = Math.max(0, slot * (1 - Math.max(0, Math.min(1, gap))));
	return bands.map((v, i) => {
		const m = Math.max(0, Math.min(1, v));
		const h = m * height;
		return { x: i * slot + (slot - w) / 2, y: height - h, w, h };
	});
}

export type Rgb = [number, number, number];

/** Map a 0..1 magnitude to an [r,g,b] heatmap colour for the spectrogram: dark → blue → teal →
 * yellow-green → red as it gets louder. A simple piecewise-linear ramp (no external palette), so a
 * scrolling spectrogram column reads the loudness of each frequency at a glance. */
export function magnitudeColor(v: number): Rgb {
	const m = Math.max(0, Math.min(1, v));
	const stops: [number, Rgb][] = [
		[0.0, [10, 12, 30]],
		[0.25, [30, 60, 170]],
		[0.5, [40, 170, 160]],
		[0.75, [180, 210, 60]],
		[1.0, [240, 80, 60]]
	];
	for (let i = 1; i < stops.length; i++) {
		if (m <= stops[i][0]) {
			const [t0, c0] = stops[i - 1];
			const [t1, c1] = stops[i];
			const f = (m - t0) / (t1 - t0 || 1);
			return [
				Math.round(c0[0] + (c1[0] - c0[0]) * f),
				Math.round(c0[1] + (c1[1] - c0[1]) * f),
				Math.round(c0[2] + (c1[2] - c0[2]) * f)
			];
		}
	}
	return stops[stops.length - 1][1];
}

/** Short label for a frequency: 100 → "100", 1000 → "1k", 1500 → "1.5k", 10000 → "10k". */
export function freqLabel(hz: number): string {
	if (hz >= 1000) {
		const k = hz / 1000;
		return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
	}
	return `${Math.round(hz)}`;
}

export type Pip = { frac: number; label: string };

/** Fractional positions (0..1, low→high) of `freqs` along the spectrum's frequency axis, using the
 * same log/linear mapping as the backend's band spacing so the pips line up with the bars. The
 * caller maps `frac` to x (bars) or y (spectrogram). Frequencies outside [fmin, fmax] are dropped. */
export function pipPositions(freqs: number[], fmin: number, fmax: number, linear: boolean): Pip[] {
	if (fmax <= fmin || fmin <= 0) return [];
	const span = linear ? fmax - fmin : Math.log(fmax) - Math.log(fmin);
	if (span <= 0) return [];
	return freqs
		.filter((f) => f >= fmin && f <= fmax)
		.map((f) => {
			const frac = linear ? (f - fmin) / span : (Math.log(f) - Math.log(fmin)) / span;
			return { frac, label: freqLabel(f) };
		});
}
