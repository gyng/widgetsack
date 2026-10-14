// Installed-font → @font-face rules (the pure half of bridge/fonts.ts ensureFont). Mirrors the Rust
// `SystemFont` in widgetsack/src/command/fonts.rs. Chromium's sandboxed webview renders MACHINE-wide
// fonts by name (with every weight), but not PER-USER installed ones — so only those get rules, one
// per face with its real weight/style/stretch, instead of one rule that maps the whole family to
// whichever face happened to be listed first (often Bold).

export type SystemFont = {
	/** Family name (CSS `font-family`). */
	name: string;
	/** PostScript name (often a spaceless variant of the family). */
	fontName: string;
	/** Absolute path to the font file. */
	path: string;
	/** OS/2 weight class (100–900). */
	weight: number;
	style: 'normal' | 'italic' | 'oblique';
	/** CSS `font-stretch` percentage (50–200). */
	stretch: number;
	/** Installed for this user only (outside the Windows fonts dir). */
	perUser: boolean;
};

const normFont = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The faces `family` names: every face of a matching family, else the face whose PostScript name
 * matches (normalized, so a spaced family resolves its spaceless PostScript face). Pure. */
export function matchFontFaces(fonts: readonly SystemFont[], family: string): SystemFont[] {
	const want = normFont(family);
	const byFamily = fonts.filter((f) => normFont(f.name) === want);
	return byFamily.length ? byFamily : fonts.filter((f) => normFont(f.fontName) === want);
}

// A single-quoted CSS string: backslash-escape `\` and `'`, hex-escape control chars (incl. newline).
const cssString = (s: string): string => {
	let body = '';
	for (const c of s) {
		const code = c.charCodeAt(0);
		if (c === '\\' || c === "'") body += `\\${c}`;
		else if (code < 0x20 || code === 0x7f) body += `\\${code.toString(16)} `;
		else body += c;
	}
	return `'${body}'`;
};

// Characters that could end or confuse a quoted url('…') token, percent-encoded.
const safeUrl = (u: string): string =>
	u.replace(
		/['"()\\\s]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
	);

/** One @font-face per PER-USER face, all under `family`, carrying the face's own weight / style /
 * stretch so the browser picks the right file per request. `toUrl` maps a file path to a loadable
 * URL (the asset protocol). '' when there is nothing to load. Pure. */
export function fontFaceCss(
	family: string,
	faces: readonly SystemFont[],
	toUrl: (path: string) => string
): string {
	return faces
		.filter((f) => f.perUser)
		.map((f) => {
			const fmt = f.path.toLowerCase().endsWith('.otf') ? 'opentype' : 'truetype';
			return (
				`@font-face { font-family: ${cssString(family)}; src: url('${safeUrl(toUrl(f.path))}') ` +
				`format('${fmt}'); font-weight: ${f.weight}; font-style: ${f.style}; ` +
				`font-stretch: ${f.stretch}%; font-display: swap; }`
			);
		})
		.join('\n');
}
