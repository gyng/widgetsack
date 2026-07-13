// Generate the Markdown reference for the THEMING system straight from the code that defines it:
// the token vocabulary (core/tokens.ts → DEFAULT_TOKENS) and the cascade/scoping rules
// (core/style.ts → assembleStyles/scopeCss). Pure: returns the doc string. Emitted to
// docs/theming.md by scripts/gen-widget-docs.ts. Co-located tests in themingDocs.test.ts.

import { DEFAULT_TOKENS, TOKEN_NAMES } from './tokens';
import { BUILTIN_THEMES, BUILTIN_GROUP_ORDER } from './builtinThemes';

// The studio-chrome token vocabulary (defined in styles.css :root). Hand-described here (the defaults
// live in CSS, not as importable data); a theme sets these alongside the widget --np-* tokens.
const CHROME_TOKENS: { name: string; purpose: string }[] = [
	{ name: '--ui-bg', purpose: 'Base window + opaque panel background.' },
	{ name: '--ui-surface', purpose: 'Translucent rails / docked panels.' },
	{ name: '--ui-bar-bg', purpose: 'Top / sub / bottom bars (incl. the title bar).' },
	{ name: '--ui-raised', purpose: 'Inputs, buttons, raised rows.' },
	{ name: '--ui-scrim', purpose: 'Menu / modal backdrops.' },
	{ name: '--ui-fg', purpose: 'Primary chrome text.' },
	{ name: '--ui-fg-muted', purpose: 'Secondary chrome text.' },
	{ name: '--ui-fg-dim', purpose: 'Tertiary chrome text (== the legacy --dim-fg).' },
	{ name: '--ui-border', purpose: 'Hairline borders / dividers.' },
	{ name: '--ui-border-strong', purpose: 'Stronger control borders.' },
	{ name: '--ui-accent-rgb', purpose: 'Chrome accent as "r, g, b" channels (rgb()/rgba() forms).' },
	{ name: '--ui-accent-fg', purpose: 'Bright accent text / icons / active labels.' },
	{ name: '--ui-danger-rgb', purpose: 'Destructive accent channels.' },
	{ name: '--ui-danger-fg', purpose: 'Destructive text.' },
	{ name: '--ui-success-rgb', purpose: 'Success accent channels.' },
	{ name: '--ui-success-fg', purpose: 'Success text.' },
	{ name: '--ui-warn-rgb', purpose: 'Warning accent channels.' },
	{ name: '--ui-warn-fg', purpose: 'Warning text.' },
	// Spacing / typography / shape — the studio's density knobs. Same override story as the colour
	// tokens: set at :root in a theme. Scale: 2/4/6/8/12/16.
	{ name: '--space-1', purpose: 'Spacing scale: hairline (2px).' },
	{ name: '--space-2', purpose: 'Spacing scale: tight (4px).' },
	{ name: '--space-3', purpose: 'Spacing scale: default gap (6px).' },
	{ name: '--space-4', purpose: 'Spacing scale: section / panel inset (8px).' },
	{ name: '--space-5', purpose: 'Spacing scale: large (12px).' },
	{ name: '--space-6', purpose: 'Spacing scale: screen-edge / panel padding (16px).' },
	{ name: '--text-xs', purpose: 'Type scale: smallest annotations (9px).' },
	{ name: '--text-sm', purpose: 'Type scale: section headers / hints (10px).' },
	{ name: '--text-md', purpose: 'Type scale: chrome body (11px).' },
	{ name: '--text-lg', purpose: 'Type scale: emphasized body / panel text (12px).' },
	{ name: '--text-xl', purpose: 'Type scale: panel titles (14px).' },
	{ name: '--radius-control', purpose: 'Corner radius for inputs / buttons / chips (2px).' },
	{ name: '--radius-panel', purpose: 'Corner radius for panels / cards / menus (4px).' },
	{ name: '--control-h', purpose: 'Minimum height of rail/bar inputs and selects (22px).' },
	{ name: '--disabled-opacity', purpose: 'Opacity of disabled controls (0.5).' }
];

// One-line human description per token (the prose the value/name alone can't carry). Keyed by token
// name so the table's NAMES + DEFAULTS come from DEFAULT_TOKENS (can't drift) while the wording lives
// here. A token added to DEFAULT_TOKENS without an entry still lists — with a blank description — so
// the doc never silently omits a token.
const TOKEN_DESCRIPTIONS: Record<string, string> = {
	'--np-accent': 'Primary fill / line / accent (gauges, bars, sparklines, active states).',
	'--np-fg': 'Main text and numerals.',
	'--np-muted': 'Secondary text (units, sub-labels).',
	'--np-label': 'Labels above/below a value.',
	'--np-track': 'The unfilled track behind a gauge / bar.',
	'--np-bg': 'Widget chrome background (e.g. a button surface).',
	'--np-danger': 'Error / invalid / over-threshold state.',
	'--np-warn': 'Warning / caution state.',
	'--np-success': 'OK / healthy state.',
	'--np-accent-up': 'A rising value (market ticker up, positive delta).',
	'--np-accent-down': 'A falling value (market ticker down, negative delta).',
	'--np-font': 'Body font family.',
	'--np-font-display': 'Display font family (large numerals / headings).',
	'--np-radius': 'Corner radius for widget chrome.',
	'--np-gap': 'Default gap between elements inside a widget.',
	'--np-control-size': 'Minimum target size for compact interactive controls.',
	'--np-touch-target': 'Minimum target size for large, touch-first controls.'
};

// Escape a cell value so a literal `|` can't break the Markdown table.
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();

function tokensTable(): string {
	const rows = TOKEN_NAMES.map(
		(name) =>
			`| \`${name}\` | \`${cell(DEFAULT_TOKENS[name])}\` | ${cell(
				TOKEN_DESCRIPTIONS[name] ?? ''
			)} |`
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
		if (!themes.length) return '';
		const label = group[0].toUpperCase() + group.slice(1);
		return `- **${label}** — ${themes.map((t) => t.name).join(', ')}`;
	})
		.filter(Boolean)
		.join('\n');
}

const PREAMBLE = `# Theming

> **Generated** from the code that defines the system — do not hand-edit. Run \`npm run gen:docs\`
> (in \`client/\`) to regenerate. Sources of truth: \`client/src/lib/core/tokens.ts\` (the token
> vocabulary) and \`client/src/lib/core/style.ts\` (the cascade + scoping).

A **theme** is just a CSS file (\`themes/<name>.css\` in the app config dir). It sets a handful of CSS
custom properties (**tokens**) that every widget reads, so one small file restyles all your widgets
without touching any widget. Pick, edit, duplicate, and delete themes from the studio's **Themes**
section; the active theme + any token overrides are saved with your layout and travel inside a shared
**sack**.

> A theme recolours both the **widgets** (via \`--np-*\` tokens) and the studio's own **chrome** — the
> title bar, rails, and panels — via separate \`--ui-*\` tokens, so a light theme yields a light studio.
> Set whichever you want; a widgets-only theme just leaves the \`--ui-*\` tokens at their defaults.

## Tokens

Set these at \`:root\` in a theme to recolour every widget. Their defaults are the built-in look — a
theme only needs to set the ones it changes; anything it omits falls back to the default below.
`;

const USAGE_SECTION = `## How a theme is applied

The studio assembles one stylesheet per monitor, in cascade order (later wins):

1. **The token defaults** — the table above, emitted at \`:root\` so every \`var(--np-*)\` resolves.
2. **The active theme**, verbatim — your \`:root { --np-accent: … }\` overrides, plus any custom rules.
3. **Token overrides** — the friendly fields in the Themes/Inspector panels, layered on top of the
   theme (they win until you press **Clear overrides**, and they persist across theme switches).
4. **Per-widget-type CSS**, scoped to \`[data-def="<id>"]\` (styles every instance of a designed widget).
5. **Per-instance / per-group CSS**, scoped to \`[data-w="<id>"]\` / \`[data-group="<id>"]\` (most specific).

### Authoring CSS beyond the tokens

The theme editor (Themes → ✎, or "Edit theme CSS…") is a full CSS editor. Beyond setting tokens you
can target the stable widget hooks (\`[data-w]\`, \`[data-def]\`, \`[data-group]\`, and the meters'
\`np-*\` classes). A per-widget or per-def CSS block is scoped automatically.

> **Scoping caveat:** \`@font-face\` and \`@keyframes\` **cannot** be nested, so they only work in the
> **global theme** file — not in a per-widget / per-def CSS block (there they're silently dropped).
> Put shared fonts and keyframes in the theme.

### Fonts

Name a font via the \`--np-font\` / \`--np-font-display\` tokens **or** any \`font-family:\` in your theme
CSS, and the studio loads it automatically (it scans the assembled stylesheet and \`@font-face\`s each
concrete family). A font referenced only by raw CSS still loads — you don't need to register it.

## Sharing & safety

A sack bundles your widget library + the active theme CSS + token overrides into one JSON file. Theme
CSS is injected with full access to the studio, so on import a sack's theme is **scanned** for
constructs that reach outside the app — remote \`url(...)\` / \`@import\` (which could phone home) and
full-screen overlays — and you're asked to confirm before trusting a stranger's theme.
`;

const CHROME_SECTION = `## Chrome tokens (the editor itself)

The studio chrome — title bar, rails, panels, backgrounds — is themeable too. A theme sets these
\`--ui-*\` tokens at \`:root\` alongside the widget tokens above, so picking a light theme yields a
light studio. Their dark defaults live in \`client/src/styles.css\`; a theme only sets what it changes.
Accent / state colours are RGB **channels** (e.g. \`--ui-accent-rgb: 119, 196, 211\`) so both the solid
\`rgb(var(--ui-accent-rgb))\` and translucent \`rgba(var(--ui-accent-rgb), a)\` forms work.

Beyond colour, the chrome's **density and typography** ride the same system: the \`--space-*\` scale,
\`--text-*\` type ramp, \`--radius-*\` shapes, \`--control-h\`, and \`--disabled-opacity\` below are plain
\`:root\` custom properties — a theme can compact the studio (\`--space-3: 4px; --text-md: 10px\`) or
relax it the same way it recolours it.
`;

const BUILTIN_SECTION = `## Built-in themes

The picker ships a library of immutable presets, grouped. Pick one, or **duplicate** it (⎘) to start a
new editable theme of your own. Built-ins are selected as \`builtin:<id>\` and defined in
\`client/src/lib/core/builtinThemes.ts\`.
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
