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
});
