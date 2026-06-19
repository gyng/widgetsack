import { afterEach, describe, expect, it, vi } from 'vitest';
import { cssDiagnostics } from './cssEditorLint';

const ok = () => true;

// Snapshot + restore the global CSS so the runtimeSupports tests can drive each branch.
const realCss = globalThis.CSS;
afterEach(() => {
	if (realCss === undefined) delete (globalThis as { CSS?: unknown }).CSS;
	else (globalThis as { CSS?: unknown }).CSS = realCss;
	vi.restoreAllMocks();
});

describe('cssDiagnostics', () => {
	it('returns nothing for empty or valid fragments', () => {
		expect(cssDiagnostics('')).toEqual([]);
		expect(cssDiagnostics('   ')).toEqual([]);
		expect(cssDiagnostics('color: red', { supports: ok })).toEqual([]);
		expect(cssDiagnostics('.value { color: red; font-size: 12px }', { supports: ok })).toEqual([]);
	});

	it('reports a bracket imbalance (and only that) without a parse cascade', () => {
		const d = cssDiagnostics('.value { color: red; }}', { supports: ok });
		expect(d).toHaveLength(1);
		expect(d[0].severity).toBe('error');
		expect(d[0].message).toMatch(/Unexpected/);
	});

	it('flags a syntax error in a balanced fragment', () => {
		const d = cssDiagnostics('color red;', { supports: ok });
		expect(d.some((x) => x.severity === 'error')).toBe(true);
	});

	it('flags an unknown/unsupported property via the injected supports check', () => {
		const d = cssDiagnostics('font-sze: 52px', { supports: (p) => p !== 'font-sze' });
		expect(d).toHaveLength(1);
		expect(d[0]).toMatchObject({ from: 0, to: 'font-sze'.length, severity: 'warning' });
		expect(d[0].message).toMatch(/font-sze/);
	});

	it('does not check custom properties, var()/brace values, or empty values', () => {
		expect(cssDiagnostics('--my-token: anything goes', { supports: () => false })).toEqual([]);
		expect(cssDiagnostics('color: var(--np-accent)', { supports: () => false })).toEqual([]);
		// A declaration whose value is itself a nested block (contains '{') can't be statically checked.
		expect(cssDiagnostics('grid: { foo }', { supports: () => false })).toEqual([]);
		// An empty value (trailing colon) is skipped, not flagged.
		expect(cssDiagnostics('color:', { supports: () => false })).toEqual([]);
	});

	it('caps the diagnostic count on a very broken doc', () => {
		// A flood of distinct unknown props — the gutter is capped at 50 entries.
		const lines = Array.from({ length: 80 }, (_, i) => `bad-prop-${i}: x`).join(';\n');
		const d = cssDiagnostics(lines, { supports: (p) => !p.startsWith('bad-prop') });
		expect(d.length).toBe(50);
		expect(d.every((x) => x.severity === 'warning')).toBe(true);
	});

	it('maps diagnostic positions back into the fragment (not the scope wrapper)', () => {
		const d = cssDiagnostics('color: red;\nfont-sze: 10px', { supports: (p) => p !== 'font-sze' });
		const warn = d.find((x) => x.severity === 'warning');
		expect(warn).toBeTruthy();
		// "font-sze" starts at index 12 (after "color: red;\n").
		expect(warn?.from).toBe(12);
	});

	// The default supports path (runtimeSupports) — exercised by NOT passing `supports`.
	describe('runtimeSupports (default supports)', () => {
		it('assumes valid (no warnings) when CSS is unavailable', () => {
			delete (globalThis as { CSS?: unknown }).CSS;
			expect(cssDiagnostics('font-sze: 52px')).toEqual([]);
		});

		it('flags via the runtime CSS.supports when present', () => {
			(globalThis as { CSS?: unknown }).CSS = {
				supports: (p: string) => p !== 'font-sze'
			};
			const d = cssDiagnostics('font-sze: 52px');
			expect(d).toHaveLength(1);
			expect(d[0].severity).toBe('warning');
		});

		it('treats a value as valid when CSS.supports throws', () => {
			(globalThis as { CSS?: unknown }).CSS = {
				supports: () => {
					throw new Error('malformed');
				}
			};
			expect(cssDiagnostics('color: red')).toEqual([]);
		});
	});
});
