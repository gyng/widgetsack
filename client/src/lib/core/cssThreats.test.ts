import { describe, expect, it } from 'vitest';
import { normalizeCss, scanCssThreats, threatSummary } from './cssThreats';

describe('scanCssThreats', () => {
	it('flags a remote url() but not local/data/asset/relative ones', () => {
		const css = `
			.a { background: url(https://evil.example/pixel.png) }
			.b { background: url('data:image/png;base64,AAAA') }
			.c { background: url(asset://localhost/x.png) }
			.d { background: url(./local.png) }`;
		const t = scanCssThreats(css);
		expect(t).toHaveLength(1);
		expect(t[0].kind).toBe('remote-url');
		expect(t[0].detail).toContain('evil.example');
	});

	it('flags protocol-relative urls and @import', () => {
		const css = `@import url(//cdn.example/theme.css);\n.x{background:url(//host/a.png)}`;
		const kinds = scanCssThreats(css).map((t) => t.kind);
		expect(kinds).toContain('import');
		expect(kinds).toContain('remote-url');
	});

	it('flags full-viewport overlays (fixed/sticky)', () => {
		const t = scanCssThreats('.overlay { position: fixed; inset: 0 }');
		expect(t.map((x) => x.kind)).toContain('overlay');
	});

	it('de-duplicates identical sites and returns nothing for benign css', () => {
		expect(scanCssThreats(':root { --np-accent: gold } .v { color: var(--np-accent) }')).toEqual(
			[]
		);
		const dup = '.a{background:url(https://h/x.png)} .b{background:url(https://h/x.png)}';
		expect(scanCssThreats(dup)).toHaveLength(1);
	});

	it('handles empty / undefined input', () => {
		expect(scanCssThreats(undefined)).toEqual([]);
		expect(scanCssThreats('')).toEqual([]);
	});

	it('sees through CSS escapes: \\75rl( is url(, posi\\74ion is position, \\3a is a colon', () => {
		const css = `.a { background: \\75rl(https://evil.example/p.png) }
			.b { posi\\74ion\\3a fixed; }
			.c { \\70osition: \\66ixed }`;
		const kinds = scanCssThreats(css).map((t) => t.kind);
		expect(kinds).toContain('remote-url');
		expect(kinds.filter((k) => k === 'overlay')).toHaveLength(2);
	});

	it('sees through comments and whitespace splitting', () => {
		const css = `@import/**/url(//cdn.example/x.css);
			.a { background:  url(
				https://evil.example/a.png ) }
			.b { position :\n\tfixed }
			/* url(https://commented.example/out.png) */`;
		const t = scanCssThreats(css);
		// (the @import's own url() is also a remote-url site, as before)
		expect(t.map((x) => x.kind).sort()).toEqual(['import', 'overlay', 'remote-url', 'remote-url']);
		// the comment is a token separator (not a bypass), and whitespace is collapsed in the detail
		expect(t.find((x) => x.kind === 'import')?.detail).toBe('@import url(//cdn.example/x.css)');
		// a url inside a comment is not a fetch
		expect(t.some((x) => x.detail.includes('commented.example'))).toBe(false);
	});

	it('flags image(), image-set() and src() remote targets like url()', () => {
		const css = `
			.a { background: image-set("https://evil.example/1x.png" 1x, "https://evil.example/2x.png" 2x) }
			.b { background: -webkit-image-set(url(//cdn.example/a.png) 1x) }
			.c { background: image(https://evil.example/i.png) }
			@font-face { src: src(https://evil.example/f.woff2) }
			.d { background: image-set("local.png" 1x) }`;
		const t = scanCssThreats(css);
		expect(t.every((x) => x.kind === 'remote-url')).toBe(true);
		expect(t).toHaveLength(4);
	});

	it('normalizeCss decodes escapes safely (NUL / out-of-range → U+FFFD, other chars stand for themselves)', () => {
		expect(normalizeCss('a\\0 b')).toBe('a\ufffdb');
		expect(normalizeCss('a\\110000 b')).toBe('a\ufffdb');
		expect(normalizeCss('a\\:b')).toBe('a:b');
		expect(normalizeCss('x /* } */  y')).toBe('x y');
	});

	it('truncates a long match to ~80 chars with an ellipsis', () => {
		const longUrl = `url(https://evil.example/${'a'.repeat(100)})`;
		const t = scanCssThreats(`.a { background: ${longUrl} }`);
		expect(t).toHaveLength(1);
		expect(t[0].detail.length).toBe(78);
		expect(t[0].detail.endsWith('…')).toBe(true);
	});
});

describe('threatSummary', () => {
	it('summarises remote + overlay counts, empty when clean', () => {
		expect(threatSummary([])).toBe('');
		const s = threatSummary([
			{ kind: 'remote-url', detail: 'url(https://h/a)' },
			{ kind: 'import', detail: '@import url(//h/b)' },
			{ kind: 'overlay', detail: 'position: fixed' }
		]);
		expect(s).toContain('2 remote resources');
		expect(s).toContain('1 full-screen overlay rule');
	});

	it('uses singular wording for exactly one remote resource, omitting the overlay clause', () => {
		const s = threatSummary([{ kind: 'remote-url', detail: 'url(https://h/a)' }]);
		expect(s).toBe('1 remote resource (could phone home)');
	});

	it('uses plural wording for multiple overlay rules, omitting the remote clause', () => {
		const s = threatSummary([
			{ kind: 'overlay', detail: 'position: fixed' },
			{ kind: 'overlay', detail: 'position: sticky' }
		]);
		expect(s).toBe('2 full-screen overlay rules');
	});
});
