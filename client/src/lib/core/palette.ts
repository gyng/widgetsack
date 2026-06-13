// Auto-theme colours derived from the wallpaper (issue #15) — Material-You-ish, but tuned to stay
// READABLE: widgets float over the wallpaper, so the derived text colour flips white/dark by the
// wallpaper's overall luminance and the accent is nudged to keep contrast. Pure colour math (no DOM):
// the canvas pixel-sampling lives in an adapter; this takes the sampled pixels in and returns a Tokens
// map out, so the whole derivation is unit-tested. Co-located tests in palette.test.ts.

import { DEFAULT_TOKENS, type Tokens } from './tokens';

export type RGB = [number, number, number];

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round = (v: number): number => Math.round(v);

/** sRGB [0..255]³ → HSL (h 0..360, s 0..1, l 0..1). */
export function rgbToHsl([r, g, b]: RGB): [number, number, number] {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return [0, 0, l];
	const s = d / (1 - Math.abs(2 * l - 1));
	let h: number;
	if (max === rn) h = ((gn - bn) / d) % 6;
	else if (max === gn) h = (bn - rn) / d + 2;
	else h = (rn - gn) / d + 4;
	h *= 60;
	if (h < 0) h += 360;
	return [h, clamp(s, 0, 1), l];
}

/** HSL → sRGB [0..255]³ (rounded). */
export function hslToRgb([h, s, l]: [number, number, number]): RGB {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	let r1 = 0;
	let g1 = 0;
	let b1 = 0;
	if (hp < 1) [r1, g1, b1] = [c, x, 0];
	else if (hp < 2) [r1, g1, b1] = [x, c, 0];
	else if (hp < 3) [r1, g1, b1] = [0, c, x];
	else if (hp < 4) [r1, g1, b1] = [0, x, c];
	else if (hp < 5) [r1, g1, b1] = [x, 0, c];
	else [r1, g1, b1] = [c, 0, x];
	const m = l - c / 2;
	return [round((r1 + m) * 255), round((g1 + m) * 255), round((b1 + m) * 255)];
}

/** WCAG relative luminance (0 black … 1 white). */
export function relLuminance([r, g, b]: RGB): number {
	const lin = (c: number): number => {
		const cs = c / 255;
		return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio (1..21) between two relative luminances. */
export function contrast(l1: number, l2: number): number {
	const hi = Math.max(l1, l2);
	const lo = Math.min(l1, l2);
	return (hi + 0.05) / (lo + 0.05);
}

export const rgbCss = ([r, g, b]: RGB): string => `rgb(${r}, ${g}, ${b})`;
export const rgbaCss = ([r, g, b]: RGB, a: number): string => `rgba(${r}, ${g}, ${b}, ${a})`;

export type Bucket = { color: RGB; count: number };

/** Quantise sampled pixels into colour buckets (coarse `step`-sized cubes), each carrying the AVERAGE
 * colour of its members, sorted by population (desc). Pure. */
export function quantize(samples: RGB[], step = 24): Bucket[] {
	const acc = new Map<number, { r: number; g: number; b: number; n: number }>();
	for (const [r, g, b] of samples) {
		const key = (Math.floor(r / step) << 16) | (Math.floor(g / step) << 8) | Math.floor(b / step);
		const e = acc.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
		e.r += r;
		e.g += g;
		e.b += b;
		e.n += 1;
		acc.set(key, e);
	}
	return [...acc.values()]
		.map((e) => ({
			color: [round(e.r / e.n), round(e.g / e.n), round(e.b / e.n)] as RGB,
			count: e.n
		}))
		.sort((a, b) => b.count - a.count);
}

/** The average WCAG luminance across the samples (0..1). */
export function averageLuminance(samples: RGB[]): number {
	if (samples.length === 0) return 0;
	return samples.reduce((s, px) => s + relLuminance(px), 0) / samples.length;
}

/** Pick the seed accent: the most PROMINENT yet COLOURFUL bucket (population × saturation, gating out
 * near-greys and near-black/white). Falls back to the most saturated bucket, then the default accent. */
export function pickSeed(buckets: Bucket[]): RGB {
	let best: { rgb: RGB; score: number } | null = null;
	let mostSaturated: { rgb: RGB; s: number } | null = null;
	for (const { color, count } of buckets) {
		const [, s, l] = rgbToHsl(color);
		if (!mostSaturated || s > mostSaturated.s) mostSaturated = { rgb: color, s };
		// Reject near-grey and the extremes of lightness — they make poor accents.
		if (s < 0.2 || l < 0.12 || l > 0.92) continue;
		const score = count * s;
		if (!best || score > best.score) best = { rgb: color, score };
	}
	if (best) return best.rgb;
	if (mostSaturated && mostSaturated.s >= 0.12) return mostSaturated.rgb;
	// Wallpaper is essentially greyscale → keep the app's default accent.
	const dflt = DEFAULT_TOKENS['--np-accent'].match(/\d+/g)?.map(Number) as RGB | undefined;
	return dflt ?? [119, 196, 211];
}

/** Nudge a colour's lightness until it clears `minRatio` contrast against `bgLum`, heading toward the
 * readable side (lighter on a dark wallpaper, darker on a light one). Pure. */
function ensureReadable(rgb: RGB, bgLum: number, minRatio: number, lighten: boolean): RGB {
	const [h, s, l0] = rgbToHsl(rgb);
	let l = l0;
	for (let i = 0; i < 24; i++) {
		if (contrast(relLuminance(hslToRgb([h, s, l])), bgLum) >= minRatio) break;
		l = lighten ? Math.min(1, l + 0.04) : Math.max(0, l - 0.04);
	}
	return hslToRgb([h, s, l]);
}

/** Derive a readable Tokens override from sampled wallpaper pixels. Only the neutral + accent colour
 * tokens are set (semantic danger/warn/success/up/down and the fonts fall through to the active
 * theme). Returns `{}` for no samples. Pure — the heart of the auto-theme. */
export function deriveTokens(samples: RGB[]): Tokens {
	if (samples.length === 0) return {};
	const avgLum = averageLuminance(samples);
	const dark = avgLum < 0.42; // dark wallpaper → light text, and vice-versa
	const [h, sRaw] = rgbToHsl(pickSeed(quantize(samples)));
	const s = clamp(Math.max(sRaw, 0.5), 0, 0.95); // keep the accent vivid

	// Text: pure white on a dark wallpaper, near-black on a light one (maximal contrast with the
	// wallpaper, which the widgets sit directly on top of).
	const fg: RGB = dark ? [255, 255, 255] : [20, 20, 24];
	// Accent: the seed hue, lightness set for the side it must read against, then contrast-guaranteed.
	const accent = ensureReadable(hslToRgb([h, s, dark ? 0.66 : 0.42]), avgLum, 3, dark);
	// Label / secondary text: the accent hue, gently desaturated, biased toward the text side.
	const label = hslToRgb([h, 0.25, dark ? 0.86 : 0.26]);
	// Chrome surface (button bg etc.): a hue-tinted dark/light surface, translucent.
	const surface = hslToRgb([h, 0.3, dark ? 0.09 : 0.93]);

	return {
		'--np-accent': rgbCss(accent),
		'--np-fg': rgbCss(fg),
		'--np-muted': rgbaCss(fg, 0.6),
		'--np-label': rgbCss(label),
		'--np-track': rgbaCss(fg, 0.16),
		'--np-bg': rgbaCss(surface, 0.6)
	};
}
