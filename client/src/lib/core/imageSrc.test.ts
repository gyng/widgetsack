import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

	it('keeps production CSP aligned with the supported remote image schemes', () => {
		const config = JSON.parse(
			readFileSync(resolve(process.cwd(), '../widgetsack/tauri.conf.json'), 'utf8')
		) as { app: { security: { csp: string } } };
		const imgDirective = config.app.security.csp
			.split(';')
			.find((directive) => directive.trim().startsWith('img-src'));
		expect(imgDirective?.split(/\s+/)).toEqual(expect.arrayContaining(['http:', 'https:']));
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
