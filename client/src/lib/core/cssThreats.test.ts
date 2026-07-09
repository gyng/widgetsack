import { describe, expect, it } from 'vitest';
import { scanCssThreats, threatSummary } from './cssThreats';

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
