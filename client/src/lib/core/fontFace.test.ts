import { describe, expect, it } from 'vitest';
import { fontFaceCss, matchFontFaces, type SystemFont } from './fontFace';

const face = (over: Partial<SystemFont> = {}): SystemFont => ({
	name: 'Lora',
	fontName: 'Lora-Regular',
	path: String.raw`C:\Users\me\AppData\Local\Microsoft\Windows\Fonts\Lora-Regular.ttf`,
	weight: 400,
	style: 'normal',
	stretch: 100,
	perUser: true,
	...over
});

describe('matchFontFaces', () => {
	const fonts = [
		face(),
		face({ fontName: 'Lora-Bold', weight: 700, path: String.raw`C:\u\Lora-Bold.ttf` }),
		face({ name: 'Bahnschrift', fontName: 'Bahnschrift', perUser: false }),
		face({ name: 'Open Sans', fontName: 'OpenSans-Regular' })
	];

	it('matches every face of a family (normalized), or one face by its PostScript name', () => {
		expect(matchFontFaces(fonts, 'lora').map((f) => f.fontName)).toEqual([
			'Lora-Regular',
			'Lora-Bold'
		]);
		expect(matchFontFaces(fonts, 'Lora Bold').map((f) => f.fontName)).toEqual(['Lora-Bold']);
		expect(matchFontFaces(fonts, 'OpenSans').map((f) => f.name)).toEqual(['Open Sans']);
		expect(matchFontFaces(fonts, 'Nope')).toEqual([]);
	});
});

describe('fontFaceCss', () => {
	const url = (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`;

	it('emits one rule per face with its weight, style and stretch (no all-bold family)', () => {
		const css = fontFaceCss(
			'Lora',
			[
				face(),
				face({ path: String.raw`C:\f\LoraBI.otf`, weight: 700, style: 'italic', stretch: 87.5 })
			],
			url
		);
		expect(css).toBe(
			[
				"@font-face { font-family: 'Lora'; src: url('http://asset.localhost/C%3A%5CUsers%5Cme%5CAppData%5CLocal%5CMicrosoft%5CWindows%5CFonts%5CLora-Regular.ttf') format('truetype'); font-weight: 400; font-style: normal; font-stretch: 100%; font-display: swap; }",
				"@font-face { font-family: 'Lora'; src: url('http://asset.localhost/C%3A%5Cf%5CLoraBI.otf') format('opentype'); font-weight: 700; font-style: italic; font-stretch: 87.5%; font-display: swap; }"
			].join('\n')
		);
	});

	it('skips machine-wide faces — Chromium already renders those by name, with every weight', () => {
		expect(fontFaceCss('Bahnschrift', [face({ perUser: false })], url)).toBe('');
	});

	it("encodes CSS-significant characters so a ' in a path or family cannot break out of the rule", () => {
		const css = fontFaceCss("O'Neil", [face({ path: String.raw`C:\u\O'Neil (1).ttf` })], url);
		expect(css).toContain(String.raw`font-family: 'O\'Neil';`);
		expect(css).toContain("url('http://asset.localhost/C%3A%5Cu%5CO%27Neil%20%281%29.ttf')");
		// a raw (unencoded) URL still cannot escape: quotes, parens, backslashes and spaces are encoded
		expect(fontFaceCss('x', [face({ path: String.raw`a\b c'(d)"` })], (p) => p)).toContain(
			"url('a%5Cb%20c%27%28d%29%22')"
		);
		expect(fontFaceCss('a\\b\nc', [face()], (p) => p)).toContain(
			String.raw`font-family: 'a\\b\a c';`
		);
	});
});
