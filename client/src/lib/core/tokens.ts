// Framework-agnostic design tokens for widget theming (Phase 7). Meters read these CSS
// custom properties with fallbacks (= today's look), so setting a token restyles every
// meter without touching component code — and a theme is just a CSS file that sets them
// (and/or targets the stable `np-*` hooks). Pure data + a tiny CSS emitter; a React port
// reuses this verbatim. Co-located vitest tests in tokens.test.ts.

export type Tokens = Record<string, string>;

/** The token vocabulary + default values (the Bahnschrift / teal-green look). A per-instance
 * `color`/`track` override beats the token; the token beats this literal fallback. */
export const DEFAULT_TOKENS: Tokens = {
	'--np-accent': 'rgb(119, 196, 211)', // primary fill / line / accent
	'--np-fg': '#ffffff', // main text / numerals
	'--np-muted': 'rgba(255, 255, 255, 0.6)', // secondary text (units)
	'--np-label': 'rgb(218, 237, 226)', // labels
	'--np-track': 'rgba(255, 255, 255, 0.15)', // gauge / bar track
	'--np-bg': 'rgba(10, 10, 12, 0.6)', // widget chrome background (e.g. button)
	// Semantic state colours so a theme can recolour error/warn/ok + market up/down once, instead of
	// each meter hardcoding its own literal (Timer/Transcribe error red, Ticker up/down, …). Meters
	// read these with a literal fallback; a theme overrides them at :root like any other token.
	'--np-danger': '#e5484d', // error / invalid / over-threshold
	'--np-warn': '#e2a03f', // warning / caution
	'--np-success': '#3fb950', // ok / healthy
	'--np-accent-up': '#3fb950', // a rising value (market ticker up, positive delta)
	'--np-accent-down': '#f85149', // a falling value (market ticker down, negative delta)
	'--np-font': "'Bahnschrift', 'Arial Narrow', sans-serif",
	'--np-font-display': "'Bahnschrift', 'Arial Narrow', sans-serif",
	'--np-radius': '2px',
	'--np-gap': '4px',
	'--np-control-size': '28px', // compact interactive control target
	'--np-touch-target': '44px' // large / touch-first control target
};

// CSS generic family keywords (+ global values): a font-family value leading with one of these has
// no installed file to load, so the font loader skips it.
const GENERIC_FAMILIES = new Set([
	'sans-serif',
	'serif',
	'monospace',
	'cursive',
	'fantasy',
	'system-ui',
	'ui-sans-serif',
	'ui-serif',
	'ui-monospace',
	'ui-rounded',
	'math',
	'emoji',
	'fangsong',
	'inherit',
	'initial',
	'revert',
	'revert-layer',
	'unset'
]);

/** The first concrete font family in a CSS `font-family` value (quotes stripped), or null when the
 * value leads with a generic keyword OR a `var(...)` reference. Lets the font loader pick which
 * installed family to @font-face so a configured font renders even when the webview won't enumerate
 * it (per-user). A `var(--np-font-display, …)` value is NOT a loadable font name — the concrete font
 * comes from the token's own value (scanned separately) or the var()'s fallback, so it's skipped;
 * otherwise splitting on the first comma would yield the bogus family "var(--np-font-display". */
export function firstFontFamily(value: string): string | null {
	const first = value
		.split(',')[0]
		.trim()
		.replace(/^['"]|['"]$/g, '')
		.trim();
	if (!first || first.startsWith('var(') || GENERIC_FAMILIES.has(first.toLowerCase())) return null;
	return first;
}

export const TOKEN_NAMES: string[] = Object.keys(DEFAULT_TOKENS);

/** A tiny colour preview of a theme: its surface + accent + text. Drives the picker's swatches. */
export type Swatch = { bg: string; accent: string; fg: string };

/**
 * Parse `--name: value` custom-property declarations out of a CSS string into a token map (later
 * declaration wins, mirroring the in-file cascade; theme tokens normally sit at `:root`). Values are
 * trimmed. Pure — lets the picker derive a swatch from a user theme's CSS without applying it.
 */
export function parseTokens(css: string): Tokens {
	const out: Tokens = {};
	const re = /(--[\w-]+)\s*:\s*([^;{}]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(css)) !== null) out[m[1]] = m[2].trim();
	return out;
}

/** Derive a {bg, accent, fg} swatch from a token map, falling back to the app defaults for whatever a
 * theme leaves unset (a widgets-only theme shows on the default dark chrome surface). Pure. */
export function swatchFromTokens(tokens: Tokens): Swatch {
	return {
		bg: tokens['--ui-bg'] ?? '#0b0b0e',
		accent: tokens['--np-accent'] ?? DEFAULT_TOKENS['--np-accent'],
		fg: tokens['--np-fg'] ?? DEFAULT_TOKENS['--np-fg']
	};
}

/** The swatch for "(default)" / no theme — the app's literal fallback look. */
export const DEFAULT_SWATCH: Swatch = swatchFromTokens(DEFAULT_TOKENS);

/** Emit a `selector { --k: v; … }` rule for `tokens` (default selector `:root`). Pure. */
export function tokensToCss(tokens: Tokens, selector = ':root'): string {
	const body = Object.entries(tokens)
		.map(([k, v]) => `\t${k}: ${v};`)
		.join('\n');
	return `${selector} {\n${body}\n}`;
}

/**
 * Every concrete (non-generic) font family named anywhere in a CSS string — in `font-family:`
 * declarations AND in the `--np-font*` custom properties a theme/def/instance may set. The font
 * loader feeds each through `ensureFont` so a font referenced by raw theme/def/instance CSS (not
 * just the two font TOKENS) actually @font-faces instead of silently falling back. Quotes stripped;
 * generic keywords dropped (firstFontFamily); de-duplicated, order-preserving. Pure.
 */
export function extractFontFamilies(css: string): string[] {
	const out = new Set<string>();
	// `font-family: <list>` and the font custom-props (`--np-font`, `--np-font-display`, …). Stop the
	// value at the first ; } { so a malformed block can't swallow the rest of the sheet.
	const re = /(?:font-family|--np-font[\w-]*)\s*:\s*([^;{}]+)/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(css)) !== null) {
		const fam = firstFontFamily(m[1]);
		if (fam) out.add(fam);
	}
	return [...out];
}
