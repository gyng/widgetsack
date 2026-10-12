// Generate the Markdown reference for the THEMING system straight from the code that defines it:
// the token vocabulary (core/tokens.ts → DEFAULT_TOKENS) and the cascade/scoping rules
// (core/style.ts → assembleStyles/scopeCss). Pure: returns the doc string. Emitted to
// docs/theming.md by scripts/gen-widget-docs.ts. Co-located tests in themingDocs.test.ts.

import { DEFAULT_TOKENS, TOKEN_NAMES } from './tokens';
import { BUILTIN_THEMES, BUILTIN_GROUP_ORDER } from './builtinThemes';

// The studio-chrome token vocabulary (defined in styles.css :root). Hand-described here (the defaults
// live in CSS, not as importable data); a theme sets these alongside the widget --np-* tokens.
const CHROME_TOKENS: { name: string; purpose: string }[] = [
	{
		name: '--ui-font',
		purpose: 'Studio font family.'
	},
	{ name: '--ui-font-mono', purpose: 'Code, expressions, and identifiers.' },
	{ name: '--ui-font-weight', purpose: 'Studio body and control weight (450 by default).' },
	{ name: '--ui-bg', purpose: 'Window and panel background.' },
	{ name: '--ui-surface', purpose: 'Sidebar and docked panel backgrounds.' },
	{ name: '--ui-bar-bg', purpose: 'Toolbar, title bar, and status bar backgrounds.' },
	{ name: '--ui-raised', purpose: 'Inputs, buttons, raised rows.' },
	{ name: '--ui-scrim', purpose: 'Menu and dialog backgrounds.' },
	{ name: '--ui-fg', purpose: 'Primary Studio text.' },
	{ name: '--ui-fg-muted', purpose: 'Secondary Studio text.' },
	{ name: '--ui-fg-dim', purpose: 'Dimmed Studio text.' },
	{ name: '--ui-border', purpose: 'Borders and dividers.' },
	{ name: '--ui-border-strong', purpose: 'Stronger control borders.' },
	{ name: '--ui-accent-rgb', purpose: 'Studio accent as three RGB channels.' },
	{ name: '--ui-accent-fg', purpose: 'Selected text, icons, and labels.' },
	{ name: '--ui-danger-rgb', purpose: 'Destructive accent channels.' },
	{ name: '--ui-danger-fg', purpose: 'Destructive text.' },
	{ name: '--ui-success-rgb', purpose: 'Success accent channels.' },
	{ name: '--ui-success-fg', purpose: 'Success text.' },
	{ name: '--ui-warn-rgb', purpose: 'Warning accent channels.' },
	{ name: '--ui-warn-fg', purpose: 'Warning text.' },
	// Spacing / typography / shape — the studio's density knobs. Same override story as the colour
	// tokens: set at :root in a theme. Scale: 2/4/6/8/12/16/24/32.
	{ name: '--space-1', purpose: 'Spacing scale: hairline (2px).' },
	{ name: '--space-2', purpose: 'Spacing scale: tight (4px).' },
	{ name: '--space-3', purpose: 'Spacing scale: default gap (6px).' },
	{ name: '--space-4', purpose: 'Spacing scale: section and panel inset (8px).' },
	{ name: '--space-5', purpose: 'Spacing scale: large (12px).' },
	{ name: '--space-6', purpose: 'Spacing scale: screen edge and panel padding (16px).' },
	{ name: '--space-7', purpose: 'Spacing scale: major sections (24px).' },
	{ name: '--space-8', purpose: 'Spacing scale: structural separation (32px).' },
	{ name: '--text-xs', purpose: 'Type scale: annotations (12px).' },
	{ name: '--text-sm', purpose: 'Type scale: labels and hints (12px).' },
	{ name: '--text-md', purpose: 'Type scale: Studio body (14px).' },
	{ name: '--text-lg', purpose: 'Type scale: section headings (16px).' },
	{ name: '--text-xl', purpose: 'Type scale: panel titles (20px).' },
	{ name: '--line-caption', purpose: 'Caption line height (16px).' },
	{ name: '--line-body', purpose: 'Body line height (20px).' },
	{ name: '--line-heading', purpose: 'Heading line height (22px).' },
	{ name: '--line-title', purpose: 'Title line height (26px).' },
	{ name: '--radius-control', purpose: 'Corner radius for inputs, buttons, and chips (4px).' },
	{ name: '--radius-panel', purpose: 'Corner radius for panels, cards, and menus (6px).' },
	{ name: '--control-h', purpose: 'Minimum height of inputs and selects (32px).' },
	{ name: '--disabled-opacity', purpose: 'Opacity of disabled controls (0.5).' }
];

// One-line human description per token (the prose the value/name alone can't carry). Keyed by token
// name so the table's NAMES + DEFAULTS come from DEFAULT_TOKENS (can't drift) while the wording lives
// here. Keep this map exhaustive: generation fails on a missing description rather than publishing
// an incomplete token table.
const TOKEN_DESCRIPTIONS: Record<string, string> = {
	'--np-text-caption': 'Supporting widget text size (labels, units, metadata).',
	'--np-text-body': 'Compact content-widget body size.',
	'--np-text-heading': 'Content-widget heading size.',
	'--np-line-caption': 'Supporting widget text line height.',
	'--np-line-body': 'Content-widget body line height.',
	'--np-line-heading': 'Content-widget heading line height.',
	'--np-row-gap': 'Space between related content-widget rows.',
	'--np-accent': 'Gauge fills, chart lines, and selected states.',
	'--np-fg': 'Main text and numerals.',
	'--np-muted': 'Secondary text (units, sub-labels).',
	'--np-label': 'Labels above or below a value.',
	'--np-track': 'The unfilled part of a gauge or bar.',
	'--np-bg': 'Widget background.',
	'--np-danger': 'Errors and readings above a threshold.',
	'--np-warn': 'Warning state.',
	'--np-success': 'Normal state.',
	'--np-accent-up': 'A rising value (market ticker up, positive delta).',
	'--np-accent-down': 'A falling value (market ticker down, negative delta).',
	'--np-font': 'Body font family.',
	'--np-font-display': 'Display font family (large numerals and headings).',
	'--np-radius': 'Widget corner radius.',
	'--np-gap': 'Default gap between elements inside a widget.',
	'--np-control-size': 'Minimum target size for compact interactive controls.',
	'--np-touch-target': 'Minimum size of large touch controls.'
};

// Escape a cell value so a literal `|` can't break the Markdown table.
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();

function tokensTable(): string {
	const rows = TOKEN_NAMES.map(
		(name) =>
			/* v8 ignore next -- TOKEN_DESCRIPTIONS is exhaustive for TOKEN_NAMES. */
			`| \`${name}\` | \`${cell(DEFAULT_TOKENS[name])}\` | ${cell(TOKEN_DESCRIPTIONS[name]!)} |`
	);
	return ['| token | default | purpose |', '| --- | --- | --- |', ...rows].join('\n');
}

function chromeTokensTable(): string {
	const rows = CHROME_TOKENS.map((t) => `| \`${t.name}\` | ${cell(t.purpose)} |`);
	return ['| token | purpose |', '| --- | --- |', ...rows].join('\n');
}

function builtinCatalog(): string {
	return BUILTIN_GROUP_ORDER.map((group) => {
		const themes = BUILTIN_THEMES.filter((t) => t.group === group);
		/* v8 ignore next -- every declared catalog group intentionally contains at least one theme. */
		if (!themes.length) return '';
		const label = group[0].toUpperCase() + group.slice(1);
		return `- **${label}** — ${themes.map((t) => t.name).join(', ')}`;
	})
		.filter(Boolean)
		.join('\n');
}

const PREAMBLE = `# Themes

<!-- Generated from the theme catalog and token definitions. -->

Use a theme to change widget colors, fonts, and spacing.

1. Open **Themes** in Studio.
2. Select a theme.
3. Adjust its settings or select **Duplicate** to create an editable copy.
4. Select **Save & apply** to keep your CSS changes.

To set a different theme for each monitor, clear **apply theme to all monitors** in **Settings → Monitor**.
Select a monitor in **Layout**, then choose its theme.

A theme is a CSS file. It can change widget styles and the Studio interface.
Use widget tokens for widgets. Use Studio tokens for the editor.

## Widget tokens

A token is a named CSS value. Set tokens inside a \`:root\` rule in the theme editor.
For example:

\`\`\`css
:root {
  --np-accent: #77c4d3;
  --np-font: 'Bahnschrift', sans-serif;
}
\`\`\`

Set only the values you want to change. Other tokens keep the defaults below.
`;

const USAGE_SECTION = `## Style priority

Styles follow this cascade order. Later settings override earlier settings for the same property.

1. Built-in defaults.
2. The selected theme.
3. Token overrides from Themes or the Inspector.
4. Styles saved with a custom widget.
5. Styles on an individual widget or group.

Token overrides stay active when you change themes. Use **Clear overrides** to remove them.

## Widget CSS

Select a widget to edit its CSS in the Inspector.
Use \`&\` to target the widget itself. Rules apply only to the selected widget.
For example:

\`\`\`css
& {
  opacity: 0.8;
}
\`\`\`

Put \`@font-face\` and \`@keyframes\` rules in the theme file.
These rules do not work in individual widget CSS.
The [developer theming guide](dev/theming.md) explains selectors and style assembly.

## Fonts

Select an installed font in the theme settings, or set \`font-family\` in CSS.
The \`--np-font\` token controls body text. The \`--np-font-display\` token controls larger readings and headings.

## Sharing themes

A sack can include widget definitions, theme CSS, and token settings.
Review the import message before you accept a shared theme.
The app scans theme CSS for remote resources and rules that can cover the window.
Only import themes from sources you trust.
`;

const CHROME_SECTION = `## Studio tokens

Use these tokens to change Studio colors, spacing, and text sizes.
Set them inside the theme's \`:root\` rule.

RGB tokens contain three channels, such as \`--ui-accent-rgb: 119, 196, 211\`.
Use them with \`rgb()\` or \`rgba()\` in CSS.
`;

const BUILTIN_SECTION = `## Built-in themes

Select a built-in theme from the catalog below.
Built-in themes are read-only. Use **Duplicate** to create a copy you can edit.
`;

/** The full theming reference, generated from the token + cascade + built-in sources. Pure. */
export function themingReferenceMarkdown(): string {
	return [
		PREAMBLE,
		tokensTable(),
		'',
		CHROME_SECTION,
		chromeTokensTable(),
		'',
		BUILTIN_SECTION,
		builtinCatalog(),
		'',
		USAGE_SECTION
	].join('\n');
}
