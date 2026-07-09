import { describe, expect, it } from 'vitest';
import {
	BACKGROUND_FITS,
	fitBackgroundProps,
	fitObjectFit,
	isMediaKind,
	parseBackgroundSpec
} from './background';

describe('parseBackgroundSpec', () => {
	it('accepts a valid color/web/media spec and clamps numbers', () => {
		expect(parseBackgroundSpec({ kind: 'color', src: '#101018' })).toEqual({
			kind: 'color',
			src: '#101018'
		});
		expect(
			parseBackgroundSpec({
				kind: 'video',
				src: 'loop.mp4',
				fit: 'cover',
				opacity: 2,
				dim: -1,
				mute: false,
				loop: true
			})
		).toEqual({
			kind: 'video',
			src: 'loop.mp4',
			fit: 'cover',
			opacity: 1,
			dim: 0,
			mute: false,
			loop: true
		});
	});

	it('rejects non-objects, unknown kinds, and bad fits', () => {
		expect(parseBackgroundSpec(null)).toBeUndefined();
		expect(parseBackgroundSpec('x')).toBeUndefined();
		expect(parseBackgroundSpec({ kind: 'shader', src: 'x' })).toBeUndefined();
		// a bad fit is dropped, not fatal
		const s = parseBackgroundSpec({ kind: 'image', src: 'a.png', fit: 'wonky' });
		expect(s).toEqual({ kind: 'image', src: 'a.png' });
	});

	it('treats an empty/whitespace source as cleared (undefined)', () => {
		expect(parseBackgroundSpec({ kind: 'image', src: '   ' })).toBeUndefined();
		expect(parseBackgroundSpec({ kind: 'web', src: '' })).toBeUndefined();
		expect(parseBackgroundSpec({ kind: 'color', src: '' })).toBeUndefined();
	});

	it('treats a missing or non-string src as cleared too (the typeof src !== "string" arm)', () => {
		expect(parseBackgroundSpec({ kind: 'web' })).toBeUndefined();
		expect(parseBackgroundSpec({ kind: 'color', src: 42 })).toBeUndefined();
	});

	it('trims the source', () => {
		expect(parseBackgroundSpec({ kind: 'web', src: '  https://x  ' })?.src).toBe('https://x');
	});

	it('leaves an in-range opacity/dim untouched (the clamp01 pass-through branch)', () => {
		const s = parseBackgroundSpec({ kind: 'color', src: '#fff', opacity: 0.5, dim: 0.25 });
		expect(s?.opacity).toBe(0.5);
		expect(s?.dim).toBe(0.25);
	});
});

describe('fit helpers', () => {
	it('isMediaKind is true only for image/video', () => {
		expect(isMediaKind('image')).toBe(true);
		expect(isMediaKind('video')).toBe(true);
		expect(isMediaKind('color')).toBe(false);
		expect(isMediaKind('web')).toBe(false);
	});

	it('fitObjectFit maps every fit (tile falls back to cover for video)', () => {
		expect(fitObjectFit('contain')).toBe('contain');
		expect(fitObjectFit('fill')).toBe('fill');
		expect(fitObjectFit('center')).toBe('none');
		expect(fitObjectFit('tile')).toBe('cover');
		expect(fitObjectFit('cover')).toBe('cover');
		expect(fitObjectFit(undefined)).toBe('cover');
	});

	it('fitBackgroundProps gives a repeat for tile and a size for the rest', () => {
		expect(fitBackgroundProps('tile').backgroundRepeat).toBe('repeat');
		expect(fitBackgroundProps('cover').backgroundSize).toBe('cover');
		expect(fitBackgroundProps('fill').backgroundSize).toBe('100% 100%');
		for (const f of BACKGROUND_FITS)
			expect(fitBackgroundProps(f)).toHaveProperty('backgroundPosition');
	});
});
