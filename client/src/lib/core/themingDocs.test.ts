import { describe, expect, it } from 'vitest';
import { themingReferenceMarkdown } from './themingDocs';
import { DEFAULT_TOKENS, TOKEN_NAMES } from './tokens';
import { BUILTIN_THEMES } from './builtinThemes';

describe('themingReferenceMarkdown', () => {
	const md = themingReferenceMarkdown();

	it('documents every token in the vocabulary with its default', () => {
		for (const name of TOKEN_NAMES) {
			expect(md).toContain(`\`${name}\``);
			expect(md).toContain(`\`${DEFAULT_TOKENS[name]}\``);
		}
	});

	it('documents the themeable chrome (--ui-*) tokens', () => {
		expect(md).toContain('--ui-bg');
		expect(md).toContain('--ui-accent-rgb');
		// The chrome is now themeable (light studio) — the old "fixed identity" wording is gone.
		expect(md).toContain('## Studio tokens');
		expect(md).not.toMatch(/can't accidentally repaint/i);
	});

	it('separates theme selection from CSS editing and identifies the editor controls', () => {
		expect(md).toContain('## Select a theme');
		expect(md).toContain('## Edit theme CSS');
		expect(md).toContain('**Edit CSS**');
		expect(md).toContain('**Save & apply**');
	});

	it('lists the built-in theme catalog', () => {
		expect(md).toMatch(/Built-in themes/i);
		expect(md).toContain('Duplicate');
		expect(md).not.toContain('builtin:<id>');
		for (const name of ['App', 'Nord', 'Solarized Light'])
			expect(BUILTIN_THEMES.some((t) => t.name === name)).toBe(true);
		expect(md).toContain('Nord');
	});

	it('explains the cascade order and the scoping caveat', () => {
		expect(md).toMatch(/cascade/i);
		expect(md).toContain('Global token overrides from Themes.');
		expect(md).toContain('Token overrides and CSS on individual widgets or groups.');
		expect(md).toContain('CSS selector specificity');
		expect(md).toContain('dev/theming.md');
		expect(md).not.toContain('client/src/');
		expect(md).toMatch(/@font-face/);
	});

	it('notes the shared-sack safety scan', () => {
		expect(md).toMatch(/sack/i);
		expect(md).toMatch(/scan/i);
	});

	it('is marked generated so it is not hand-edited', () => {
		expect(md).toMatch(/Generated/);
	});
});
