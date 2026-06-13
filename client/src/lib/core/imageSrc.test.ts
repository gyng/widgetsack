import { describe, it, expect } from 'vitest';
import { isDirectUrl, imageFit } from './imageSrc';

describe('isDirectUrl', () => {
	it('detects URLs / absolute paths vs bare wallpaper filenames', () => {
		expect(isDirectUrl('https://ex.com/a.png')).toBe(true);
		expect(isDirectUrl('http://lan/a.png')).toBe(true);
		expect(isDirectUrl('data:image/png;base64,AAAA')).toBe(true);
		expect(isDirectUrl('asset://localhost/x.png')).toBe(true);
		expect(isDirectUrl('/abs/path.png')).toBe(true);
		expect(isDirectUrl('photo.jpg')).toBe(false);
		expect(isDirectUrl('  subfolder-cat.png ')).toBe(false);
	});
});

describe('imageFit', () => {
	it('normalises to a valid object-fit (default contain)', () => {
		expect(imageFit('cover')).toBe('cover');
		expect(imageFit('fill')).toBe('fill');
		expect(imageFit('none')).toBe('none');
		expect(imageFit('contain')).toBe('contain');
		expect(imageFit(undefined)).toBe('contain');
		expect(imageFit('garbage')).toBe('contain');
	});
});
