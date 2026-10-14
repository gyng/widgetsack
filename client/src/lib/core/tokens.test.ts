import { describe, expect, it } from 'vitest';
import {
	DEFAULT_SWATCH,
	DEFAULT_TOKENS,
	extractFontFamilies,
	firstFontFamily,
	parseTokens,
	safeTokenEntry,
	swatchFromTokens,
	TOKEN_NAMES,
	tokensToCss
} from './tokens';

describe('tokens', () => {
	it('the default vocabulary covers the core themeable properties', () => {
		for (const name of ['--np-accent', '--np-fg', '--np-track', '--np-font-display']) {
			expect(TOKEN_NAMES).toContain(name);
		}
		expect(DEFAULT_TOKENS['--np-accent']).toBe('rgb(119, 196, 211)');
		expect(DEFAULT_TOKENS['--np-control-size']).toBe('28px');
		expect(DEFAULT_TOKENS['--np-touch-target']).toBe('44px');
	});

	it('exposes semantic state colours so meters need not hardcode them', () => {
		for (const name of [
			'--np-danger',
			'--np-warn',
			'--np-success',
			'--np-accent-up',
			'--np-accent-down'
		]) {
			expect(TOKEN_NAMES).toContain(name);
			expect(DEFAULT_TOKENS[name]).toMatch(/^#|^rgb/);
		}
	});

	it('tokensToCss emits a :root rule by default', () => {
		const css = tokensToCss({ '--np-accent': 'red' });
		expect(css).toBe(':root {\n\t--np-accent: red;\n}');
	});

	it('tokensToCss drops entries that would escape the declaration block', () => {
		const css = tokensToCss({
			'--np-accent': 'red;} *{background:url(https://evil.example/p)} :root{--x:y',
			'--a: 0;} body{--b': '1',
			'--np-fg': 'url("data:image/png;base64,AAAA")'
		});
		expect(css).toBe(':root {\n\t--np-fg: url("data:image/png;base64,AAAA");\n}');
	});

	it.each([
		['--np-accent', 'red', true],
		['--np-font', '"Segoe UI", sans-serif', true],
		['--np-bg', "url('a;b')", true],
		['--np-label', String.raw`"say \"hi\"; ok"`, true],
		['color', 'red', false],
		['--a b', 'red', false],
		['--np-accent', 'red; color: blue', false],
		['--np-accent', 'red}', false],
		['--np-accent', '{', false],
		['--np-accent', '"unterminated', false],
		['--np-accent', '"a\nb"', false],
		['--np-accent', '"</style><img src=x>"', false],
		['--np-accent', 'red /* swallow', false],
		['--np-accent', String.raw`red\'; } body { display: none } .x { --y: '`, false],
		['--np-accent', 'red\\', false],
		['--np-accent', 'red\\\n', false],
		['--np-font', String.raw`"A" \2c sans-serif`, true],
		['--np-accent', String.raw`a\;b`, true],
		['--np-accent', 'calc((1px + 2px) * 2)', true],
		['--np-accent', 'url("a(b")', true],
		['--np-accent', '[a] b', true],
		['--np-accent', 'foo(', false],
		['--np-accent', 'a [b', false],
		['--np-accent', 'a)', false],
		['--np-accent', 'a]', false],
		['--np-accent', '(a]', false],
		['--np-accent', '([)]', false]
	])('safeTokenEntry(%s, %s) is %s', (key, value, safe) => {
		expect(safeTokenEntry(key, value)).toBe(safe);
	});

	it('tokensToCss honours a custom selector', () => {
		expect(tokensToCss({ '--np-fg': '#000' }, '.theme-light')).toBe(
			'.theme-light {\n\t--np-fg: #000;\n}'
		);
	});

	it('the default tokens round-trip into a parseable :root block', () => {
		const css = tokensToCss(DEFAULT_TOKENS);
		expect(css.startsWith(':root {')).toBe(true);
		expect(css).toContain('--np-font-display:');
	});

	it('the default display font is Bahnschrift', () => {
		expect(firstFontFamily(DEFAULT_TOKENS['--np-font-display'])).toBe('Bahnschrift');
	});
});

describe('extractFontFamilies', () => {
	it('collects concrete families from font-family declarations and --np-font* props', () => {
		const css = `:root { --np-font-display: 'Orbitron', sans-serif; }
			[data-w="x"] { font-family: "Fira Code", monospace }
			.label { font-family: sans-serif }`;
		expect(extractFontFamilies(css)).toEqual(['Orbitron', 'Fira Code']);
	});

	it('de-duplicates and drops generic-only values', () => {
		const css = 'a{font-family:Inter} b{font-family: Inter, sans-serif} c{font-family: serif}';
		expect(extractFontFamilies(css)).toEqual(['Inter']);
	});

	it('returns an empty list for css with no concrete fonts', () => {
		expect(extractFontFamilies('a{color:red} b{font-family: monospace}')).toEqual([]);
	});

	it('skips a var() font-family reference (the concrete font comes from the token decl)', () => {
		// Regression: `font-family: var(--np-font-display, 'Bahnschrift', …)` used to yield the bogus
		// family "var(--np-font-display" (split on the first comma), which ensureFont then warned about.
		const css = `:root { --np-font-display: 'Orbitron', sans-serif; }
			.np-text { font-family: var(--np-font-display, 'Bahnschrift', 'Arial Narrow', sans-serif); }`;
		const families = extractFontFamilies(css);
		expect(families).toEqual(['Orbitron']); // the token value, not the var() reference
		expect(families.some((f) => f.includes('var('))).toBe(false);
	});
});

describe('firstFontFamily', () => {
	it('returns the first concrete family with quotes stripped', () => {
		expect(firstFontFamily("'Bahnschrift', 'Arial Narrow', sans-serif")).toBe('Bahnschrift');
		expect(firstFontFamily('Segoe UI, sans-serif')).toBe('Segoe UI');
	});

	it('returns null when the value leads with a generic keyword', () => {
		expect(firstFontFamily('sans-serif')).toBeNull();
		expect(firstFontFamily(' SYSTEM-UI , Arial')).toBeNull();
		expect(firstFontFamily('')).toBeNull();
	});

	it('returns null when the value leads with a var() reference (not a loadable font)', () => {
		expect(firstFontFamily("var(--np-font-display, 'Bahnschrift', sans-serif)")).toBeNull();
		expect(firstFontFamily('var(--np-font)')).toBeNull();
		// …but a real family followed by a var() fallback still resolves the real family.
		expect(firstFontFamily("'Orbitron', var(--np-font-display)")).toBe('Orbitron');
	});
});

describe('parseTokens', () => {
	it('extracts --custom-property declarations into a trimmed map', () => {
		const css = ':root {\n\t--np-accent: #abc;\n\t--ui-bg: rgb(1, 2, 3);\n}';
		expect(parseTokens(css)).toEqual({ '--np-accent': '#abc', '--ui-bg': 'rgb(1, 2, 3)' });
	});

	it('lets a later declaration win (cascade within the file) and ignores non-token rules', () => {
		const css = 'a{color:red} :root{--np-fg:#111} .x{--np-fg:#222; padding: 4px}';
		expect(parseTokens(css)['--np-fg']).toBe('#222');
	});

	it('returns an empty map for css with no custom properties', () => {
		expect(parseTokens('.a { color: red; }')).toEqual({});
	});
});

describe('swatchFromTokens', () => {
	it('reads bg/accent/fg from the tokens', () => {
		expect(
			swatchFromTokens({ '--ui-bg': '#101010', '--np-accent': '#0f0', '--np-fg': '#eee' })
		).toEqual({ bg: '#101010', accent: '#0f0', fg: '#eee' });
	});

	it('falls back to the app defaults for anything a theme leaves unset', () => {
		// A widgets-only theme (no --ui-bg) shows on the default dark surface.
		expect(swatchFromTokens({ '--np-accent': '#f0f' })).toEqual({
			bg: '#0b0b0e',
			accent: '#f0f',
			fg: DEFAULT_TOKENS['--np-fg']
		});
	});

	it('DEFAULT_SWATCH is the app fallback look', () => {
		expect(DEFAULT_SWATCH).toEqual({
			bg: '#0b0b0e',
			accent: DEFAULT_TOKENS['--np-accent'],
			fg: DEFAULT_TOKENS['--np-fg']
		});
	});
});
