import { describe, it, expect } from 'vitest';
import {
	rgbToHsl,
	hslToRgb,
	relLuminance,
	contrast,
	quantize,
	pickSeed,
	averageLuminance,
	deriveTokens,
	rgbCss,
	rgbaCss,
	type RGB
} from './palette';

describe('colour conversions', () => {
	it('rgb↔hsl round-trips representative colours', () => {
		for (const c of [
			[255, 0, 0],
			[0, 128, 64],
			[30, 60, 120],
			[200, 200, 40]
		] as RGB[]) {
			const back = hslToRgb(rgbToHsl(c));
			expect(back[0]).toBeCloseTo(c[0], -1);
			expect(back[1]).toBeCloseTo(c[1], -1);
			expect(back[2]).toBeCloseTo(c[2], -1);
		}
	});

	it('greys have zero saturation', () => {
		expect(rgbToHsl([128, 128, 128])[1]).toBe(0);
	});

	it('luminance + contrast match WCAG anchors', () => {
		expect(relLuminance([255, 255, 255])).toBeCloseTo(1, 5);
		expect(relLuminance([0, 0, 0])).toBeCloseTo(0, 5);
		expect(contrast(1, 0)).toBeCloseTo(21, 1);
		// contrast is symmetric in its arguments (it sorts hi/lo internally).
		expect(contrast(0, 1)).toBeCloseTo(21, 1);
	});

	it('hslToRgb covers all six hue sextants (a full hue sweep round-trips)', () => {
		// One pure hue per 60° sextant — exercises every branch of the hp<n chain, incl. blue→magenta
		// (hp∈[4,5)) and magenta→red (hp≥5) which the representative round-trip set above misses.
		const hues: Array<[number, RGB]> = [
			[0, [255, 0, 0]], // red          (hp 0)
			[60, [255, 255, 0]], // yellow    (hp 1)
			[120, [0, 255, 0]], // green      (hp 2)
			[180, [0, 255, 255]], // cyan     (hp 3)
			[240, [0, 0, 255]], // blue       (hp 4)
			[300, [255, 0, 255]] // magenta   (hp 5)
		];
		for (const [h, rgb] of hues) {
			expect(hslToRgb([h, 1, 0.5])).toEqual(rgb);
		}
	});

	it('hslToRgb wraps an out-of-range / negative hue into [0,360)', () => {
		expect(hslToRgb([360, 1, 0.5])).toEqual([255, 0, 0]); // 360 ≡ 0 (red)
		expect(hslToRgb([-60, 1, 0.5])).toEqual([255, 0, 255]); // -60 ≡ 300 (magenta)
	});

	it('rgbToHsl wraps a negative computed hue (red-dominant, blue>green) back into [0,360)', () => {
		// magenta-leaning red: max is red, gn-bn is negative → raw hue < 0 → the `h += 360` branch.
		const [h] = rgbToHsl([255, 0, 128]);
		expect(h).toBeGreaterThan(300);
		expect(h).toBeLessThan(360);
	});

	it('rgbToHsl reports hue for green- and blue-dominant colours (the other max branches)', () => {
		expect(rgbToHsl([0, 255, 0])[0]).toBeCloseTo(120, 1); // green max
		expect(rgbToHsl([0, 0, 255])[0]).toBeCloseTo(240, 1); // blue max
	});

	it('rgbCss / rgbaCss format CSS colour strings', () => {
		expect(rgbCss([1, 2, 3])).toBe('rgb(1, 2, 3)');
		expect(rgbaCss([1, 2, 3], 0.5)).toBe('rgba(1, 2, 3, 0.5)');
	});
});

describe('quantize + pickSeed', () => {
	it('buckets by population with averaged colours', () => {
		const samples: RGB[] = [...Array(10).fill([200, 30, 30]), ...Array(3).fill([30, 30, 200])];
		const b = quantize(samples);
		expect(b[0].count).toBe(10);
		expect(b[0].color[0]).toBeGreaterThan(150); // reddish bucket leads
	});

	it('prefers a prominent, colourful seed over a dominant grey', () => {
		const samples: RGB[] = [
			...Array(80).fill([40, 40, 44]), // dominant dark grey
			...Array(40).fill([60, 110, 210]), // prominent blue
			...Array(10).fill([220, 40, 40]) // rare vivid red
		];
		const [h, s] = rgbToHsl(pickSeed(quantize(samples)));
		expect(s).toBeGreaterThan(0.2); // not the grey
		expect(h).toBeGreaterThan(180); // blue hue, not red
		expect(h).toBeLessThan(260);
	});

	it('falls back to the default accent for a greyscale image', () => {
		const grey: RGB[] = Array(50).fill([90, 90, 90]);
		const seed = pickSeed(quantize(grey));
		// The default teal accent (119,196,211) — bluish, not grey.
		expect(seed[2]).toBeGreaterThan(seed[0]);
	});

	it('falls back to the most-saturated bucket when every colour fails the strict accent gate', () => {
		// A muted blue with saturation in [0.12, 0.2): rejected by the strict gate (s < 0.2 continue),
		// but it clears the loose `mostSaturated.s >= 0.12` fallback, so it — not the default — is the seed.
		const muted: RGB = [96, 110, 140]; // s ≈ 0.18
		const sCheck = rgbToHsl(muted)[1];
		expect(sCheck).toBeGreaterThan(0.12);
		expect(sCheck).toBeLessThan(0.2);
		const seed = pickSeed(quantize([muted]));
		expect(rgbToHsl(seed)[0]).toBeCloseTo(rgbToHsl(muted)[0], -1); // blue hue preserved, not the teal default
	});

	it('averageLuminance is 0 for an empty sample set', () => {
		expect(averageLuminance([])).toBe(0);
	});
});

describe('deriveTokens', () => {
	it('returns {} for no samples', () => {
		expect(deriveTokens([])).toEqual({});
	});

	it('uses light text on a dark wallpaper', () => {
		const dark: RGB[] = [...Array(90).fill([18, 22, 40]), ...Array(20).fill([60, 110, 210])];
		const t = deriveTokens(dark);
		expect(averageLuminance(dark)).toBeLessThan(0.42);
		expect(t['--np-fg']).toBe('rgb(255, 255, 255)');
		expect(t['--np-muted']).toContain('255, 255, 255');
		// Accent contrasts with the dark wallpaper (≥3:1).
		const accent = (t['--np-accent'].match(/\d+/g) ?? []).map(Number) as RGB;
		expect(contrast(relLuminance(accent), averageLuminance(dark))).toBeGreaterThanOrEqual(2.9);
	});

	it('uses dark text on a light wallpaper', () => {
		const light: RGB[] = [...Array(90).fill([235, 232, 224]), ...Array(20).fill([210, 150, 60])];
		const t = deriveTokens(light);
		expect(averageLuminance(light)).toBeGreaterThan(0.42);
		expect(t['--np-fg']).toBe('rgb(20, 20, 24)');
		expect(t['--np-muted']).toContain('20, 20, 24');
	});

	it('only overrides neutral + accent tokens (semantic colours fall through)', () => {
		const t = deriveTokens([[30, 60, 120]]);
		expect(Object.keys(t).sort()).toEqual(
			['--np-accent', '--np-bg', '--np-fg', '--np-label', '--np-muted', '--np-track'].sort()
		);
	});

	it('lightens the accent until readable on a borderline-dark wallpaper (the lighten loop runs)', () => {
		// avgLum just under the 0.42 dark threshold → a mid-light seed accent (l≈0.66) starts BELOW 3:1,
		// so ensureReadable must iterate, lightening (l += 0.04) until it clears contrast.
		const wall: RGB[] = Array(60).fill([150, 110, 60]); // warm mid-dark, avg lum < 0.42 but not tiny
		expect(averageLuminance(wall)).toBeLessThan(0.42);
		const t = deriveTokens(wall);
		const accent = (t['--np-accent'].match(/\d+/g) ?? []).map(Number) as RGB;
		expect(contrast(relLuminance(accent), averageLuminance(wall))).toBeGreaterThanOrEqual(2.9);
	});

	it('darkens the accent until readable on a light wallpaper (the darken loop runs)', () => {
		// Light wallpaper → lighten=false; a seed accent at l≈0.42 may start below 3:1 against a bright
		// background, forcing the darken arm (l -= 0.04) of the readability loop.
		const wall: RGB[] = Array(60).fill([210, 205, 120]); // bright warm, avg lum > 0.42
		expect(averageLuminance(wall)).toBeGreaterThan(0.42);
		const t = deriveTokens(wall);
		const accent = (t['--np-accent'].match(/\d+/g) ?? []).map(Number) as RGB;
		expect(contrast(relLuminance(accent), averageLuminance(wall))).toBeGreaterThanOrEqual(2.9);
	});
});
