import { afterEach, describe, expect, it } from 'vitest';
import { isValidColor, TOKEN_FIELDS } from './themeTokens';

// A handle to swap the global `CSS` object (happy-dom provides one with a working `supports`).
const g = globalThis as unknown as { CSS?: typeof CSS };
const originalCSS = g.CSS;
afterEach(() => {
	g.CSS = originalCSS;
});

describe('isValidColor', () => {
	it('treats an empty value as valid (an empty override is not an error)', () => {
		expect(isValidColor('')).toBe(true);
		expect(isValidColor('   ')).toBe(true);
	});

	it('accepts a CSS-valid colour when CSS.supports is available', () => {
		expect(isValidColor('rebeccapurple')).toBe(true);
		expect(isValidColor('#77c4d3')).toBe(true);
	});

	it('is lenient (returns true) when CSS is unavailable', () => {
		g.CSS = undefined;
		// With no CSS API at all it can't validate, so it never false-flags a typo as invalid.
		expect(isValidColor('definitely-not-a-real-colour')).toBe(true);
	});

	it('is lenient when CSS.supports is not a function', () => {
		g.CSS = {} as typeof CSS;
		expect(isValidColor('whatever')).toBe(true);
	});
});

describe('TOKEN_FIELDS', () => {
	it('surfaces the common theme tokens, each with a --np-* key and a kind', () => {
		expect(TOKEN_FIELDS.length).toBeGreaterThan(0);
		for (const t of TOKEN_FIELDS) {
			expect(t.key.startsWith('--np-')).toBe(true);
			expect(['color', 'font', 'text']).toContain(t.kind);
		}
	});
});
