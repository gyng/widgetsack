// Built-in theme library: a curated set of immutable, frontend-owned theme presets shown in the
// studio's theme picker alongside the user's own themes. A theme is a `:root { … }` block that sets
// BOTH the widget tokens (--np-*) and the studio-chrome tokens (--ui-*), so picking one restyles the
// WHOLE studio (title bar, rails, panels, backgrounds) AND the widgets — a light preset yields a light
// studio. Pure data + a tiny emitter (reuses tokensToCss); ZERO React/Tauri (AGENTS.md §5). A preset
// is selected as `builtin:<id>` so its id can never collide with a user theme's filename, and the
// existing string-based persistence (widgets.json `theme`) + dirty diff keep working unchanged.
// Co-located tests in builtinThemes.test.ts.
import { DEFAULT_TOKENS, swatchFromTokens, tokensToCss, type Swatch, type Tokens } from './tokens';

export type BuiltinGroup = 'classic' | 'light' | 'dark' | 'fun';
export type BuiltinTheme = {
	id: string;
	name: string;
	group: BuiltinGroup;
	css: string;
	swatch: Swatch; // a {bg, accent, fg} preview for the picker
};

/** The prefix marking a selected theme as one of these presets (vs a user file). */
export const BUILTIN_PREFIX = 'builtin:';

// A compact palette spec, expanded to the full --ui-*/--np-* token map by `specTokens`. Only the
// distinctive colours are required; the rest derive sensible defaults from the `light` flag. The
// `*Fg` fields are the legible text/icon tint (default = the base hex), which matters most for light
// themes where the saturated accent must darken to read on a pale surface.
type Spec = {
	id: string;
	name: string;
	group: BuiltinGroup;
	light?: boolean;
	// chrome surfaces + text
	bg: string;
	surface: string;
	raised: string;
	border: string;
	borderStrong?: string;
	fg: string;
	fgMuted: string;
	fgDim: string;
	barBg?: string;
	scrim?: string;
	// accent + state (hex)
	accent: string;
	accentFg?: string;
	danger: string;
	dangerFg?: string;
	success: string;
	successFg?: string;
	warn: string;
	warnFg?: string;
	// widget overrides (default to the chrome equivalents / the flag-driven defaults)
	npAccent?: string;
	npFg?: string;
	npLabel?: string;
	npTrack?: string;
	npBg?: string;
	font?: string;
	fontDisplay?: string;
};

/** "#rrggbb" | "#rgb" → "r, g, b" channel triple (for `rgb()` / `rgba(var(--x), a)`). Pure. */
export function hexToRgb(hex: string): string {
	let h = hex.trim().replace(/^#/, '');
	if (h.length === 3)
		h = h
			.split('')
			.map((c) => c + c)
			.join('');
	const n = parseInt(h, 16);
	return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function specTokens(s: Spec): Tokens {
	/* v8 ignore next -- every catalog spec supplies accentFg; fallback protects future hand-authored specs. */
	const accentFg = s.accentFg ?? s.accent;
	return {
		// --- chrome ---
		'--ui-bg': s.bg,
		'--ui-surface': s.surface,
		'--ui-bar-bg': s.barBg ?? s.surface,
		'--ui-raised': s.raised,
		'--ui-scrim': s.scrim ?? (s.light ? 'rgba(0, 0, 0, 0.25)' : 'rgba(0, 0, 0, 0.5)'),
		'--ui-fg': s.fg,
		'--ui-fg-muted': s.fgMuted,
		'--ui-fg-dim': s.fgDim,
		'--ui-border': s.border,
		/* v8 ignore next -- every catalog spec supplies borderStrong; fallback protects future specs. */
		'--ui-border-strong': s.borderStrong ?? s.border,
		'--ui-accent-rgb': hexToRgb(s.accent),
		'--ui-accent-fg': accentFg,
		'--ui-danger-rgb': hexToRgb(s.danger),
		'--ui-danger-fg': s.dangerFg ?? s.danger,
		'--ui-success-rgb': hexToRgb(s.success),
		'--ui-success-fg': s.successFg ?? s.success,
		'--ui-warn-rgb': hexToRgb(s.warn),
		'--ui-warn-fg': s.warnFg ?? s.warn,
		// --- widgets ---
		'--np-accent': s.npAccent ?? s.accent,
		'--np-fg': s.npFg ?? s.fg,
		'--np-muted': s.light ? 'rgba(0, 0, 0, 0.55)' : 'rgba(255, 255, 255, 0.6)',
		'--np-label': s.npLabel ?? accentFg,
		'--np-track': s.npTrack ?? (s.light ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.15)'),
		'--np-bg': s.npBg ?? (s.light ? 'rgba(255, 255, 255, 0.7)' : 'rgba(10, 10, 12, 0.6)'),
		'--np-danger': s.danger,
		'--np-warn': s.warn,
		'--np-success': s.success,
		'--np-accent-up': s.success,
		'--np-accent-down': s.danger,
		'--np-font': s.font ?? DEFAULT_TOKENS['--np-font'],
		'--np-font-display': s.fontDisplay ?? s.font ?? DEFAULT_TOKENS['--np-font-display']
	};
}

// The catalog. Order within each group is the picker order. Keep `app` first — it reproduces the
// canonical dark/teal defaults, so it's the explicit "back to the house look" preset.
const SPECS: Spec[] = [
	// --- Classic ---
	{
		id: 'app',
		name: 'App',
		group: 'classic',
		bg: '#0b0b0e',
		surface: 'rgba(10, 10, 12, 0.92)',
		raised: '#1a1a1e',
		border: '#2a2a30',
		borderStrong: '#444444',
		fg: '#eeeeee',
		fgMuted: '#aaaaaa',
		fgDim: '#8a8a8a',
		accent: '#77c4d3',
		accentFg: '#96d6e4',
		danger: '#dc7878',
		dangerFg: '#e6a0a0',
		success: '#8cc8aa',
		warn: '#ffa05a',
		warnFg: '#dcb48c',
		npFg: '#ffffff',
		npLabel: '#daede2'
	},
	{
		id: 'mono',
		name: 'Mono',
		group: 'classic',
		bg: '#0e0e10',
		surface: 'rgba(14, 14, 16, 0.92)',
		raised: '#1c1c1f',
		border: '#2c2c30',
		borderStrong: '#454549',
		fg: '#ececec',
		fgMuted: '#a8a8a8',
		fgDim: '#878787',
		accent: '#d8dee9',
		accentFg: '#eceff4',
		danger: '#d98a8a',
		success: '#a8c8b4',
		warn: '#d8c08a',
		npFg: '#f0f0f0',
		npLabel: '#cfd6e0'
	},
	{
		id: 'amber',
		name: 'Amber',
		group: 'classic',
		bg: '#100c06',
		surface: 'rgba(18, 14, 8, 0.92)',
		raised: '#1f1810',
		border: '#3a2e18',
		borderStrong: '#4f3e20',
		fg: '#ffe9c8',
		fgMuted: '#c9a96e',
		fgDim: '#9a8050',
		accent: '#ffb000',
		accentFg: '#ffd27f',
		danger: '#e0795a',
		success: '#c9b06a',
		warn: '#ff9d3a',
		npLabel: '#ffd27f'
	},
	{
		id: 'slate',
		name: 'Slate',
		group: 'classic',
		bg: '#0d1117',
		surface: 'rgba(13, 17, 23, 0.92)',
		raised: '#161b22',
		border: '#283041',
		borderStrong: '#3a4658',
		fg: '#e6edf3',
		fgMuted: '#9aa7b4',
		fgDim: '#768390',
		accent: '#58a6ff',
		accentFg: '#79c0ff',
		danger: '#f85149',
		dangerFg: '#ff7b72',
		success: '#3fb950',
		warn: '#d29922'
	},
	{
		id: 'steel',
		name: 'Steel',
		group: 'classic',
		bg: '#0b1014',
		surface: 'rgba(11, 16, 20, 0.92)',
		raised: '#13202a',
		border: '#22323d',
		borderStrong: '#314753',
		fg: '#dfeaf0',
		fgMuted: '#9fb3bd',
		fgDim: '#75909c',
		accent: '#5fb3c9',
		accentFg: '#8fd3e3',
		danger: '#e08a7a',
		success: '#7fc6a8',
		warn: '#e0b06a'
	},
	// --- Light ---
	{
		id: 'paper',
		name: 'Paper',
		group: 'light',
		light: true,
		bg: '#f7f6f3',
		surface: '#ffffff',
		raised: '#eceae4',
		border: '#d9d6cd',
		borderStrong: '#c4c0b4',
		fg: '#2b2b29',
		fgMuted: '#5f5d57',
		fgDim: '#8a877f',
		accent: '#0a7ea4',
		accentFg: '#076485',
		danger: '#c0392b',
		dangerFg: '#a52f23',
		success: '#2e8b57',
		warn: '#b8860b',
		npFg: '#2b2b29',
		npLabel: '#0a7ea4'
	},
	{
		id: 'solarized-light',
		name: 'Solarized Light',
		group: 'light',
		light: true,
		bg: '#fdf6e3',
		surface: '#fbf1d3',
		raised: '#eee8d5',
		border: '#e0d9bf',
		borderStrong: '#ccc4a8',
		fg: '#586e75',
		fgMuted: '#657b83',
		fgDim: '#93a1a1',
		accent: '#268bd2',
		accentFg: '#1d6fa8',
		danger: '#dc322f',
		success: '#859900',
		successFg: '#6b7d00',
		warn: '#b58900',
		npFg: '#073642',
		npLabel: '#2aa198'
	},
	{
		id: 'nord-light',
		name: 'Nord Light',
		group: 'light',
		light: true,
		bg: '#eceff4',
		surface: '#f4f6f9',
		raised: '#e0e4ec',
		border: '#d2d8e0',
		borderStrong: '#bcc4d0',
		fg: '#2e3440',
		fgMuted: '#4c566a',
		fgDim: '#7b8394',
		accent: '#5e81ac',
		accentFg: '#436390',
		danger: '#bf616a',
		dangerFg: '#a04852',
		success: '#5b8a3a',
		warn: '#b5651f'
	},
	{
		id: 'daylight',
		name: 'Daylight',
		group: 'light',
		light: true,
		bg: '#fafafa',
		surface: '#ffffff',
		raised: '#f0f0f0',
		border: '#e2e2e2',
		borderStrong: '#cccccc',
		fg: '#1f2328',
		fgMuted: '#57606a',
		fgDim: '#8c959f',
		accent: '#0969da',
		accentFg: '#0550ae',
		danger: '#cf222e',
		success: '#1a7f37',
		warn: '#9a6700'
	},
	{
		id: 'mint-light',
		name: 'Mint Light',
		group: 'light',
		light: true,
		bg: '#f3faf6',
		surface: '#ffffff',
		raised: '#e6f3ec',
		border: '#d2e8dc',
		borderStrong: '#bcd9c9',
		fg: '#1f2e27',
		fgMuted: '#4f6358',
		fgDim: '#7d9488',
		accent: '#0f9d76',
		accentFg: '#0a7a5b',
		danger: '#c0392b',
		success: '#2e8b57',
		warn: '#b07d10'
	},
	{
		id: 'linen',
		name: 'Linen',
		group: 'light',
		light: true,
		bg: '#faf6f0',
		surface: '#fffdfa',
		raised: '#f0e9df',
		border: '#e2d8c8',
		borderStrong: '#cdbfa8',
		fg: '#33302b',
		fgMuted: '#6b6358',
		fgDim: '#938979',
		accent: '#b5651d',
		accentFg: '#8f4f16',
		danger: '#b3402f',
		success: '#5b7a3f',
		warn: '#9a6f10'
	},
	// --- Dark ---
	{
		id: 'nord',
		name: 'Nord',
		group: 'dark',
		bg: '#2e3440',
		surface: 'rgba(43, 49, 60, 0.92)',
		raised: '#3b4252',
		border: '#434c5e',
		borderStrong: '#4c566a',
		fg: '#eceff4',
		fgMuted: '#d8dee9',
		fgDim: '#a8b1c2',
		accent: '#88c0d0',
		accentFg: '#8fbcbb',
		danger: '#bf616a',
		dangerFg: '#d4818a',
		success: '#a3be8c',
		warn: '#ebcb8b',
		npLabel: '#8fbcbb'
	},
	{
		id: 'dracula',
		name: 'Dracula',
		group: 'dark',
		bg: '#282a36',
		surface: 'rgba(34, 35, 46, 0.92)',
		raised: '#343746',
		border: '#44475a',
		borderStrong: '#565a72',
		fg: '#f8f8f2',
		fgMuted: '#c8c9d6',
		fgDim: '#9aa0b3',
		accent: '#bd93f9',
		accentFg: '#d6b6ff',
		danger: '#ff5555',
		success: '#50fa7b',
		warn: '#f1fa8c',
		warnFg: '#ecf08a',
		npLabel: '#8be9fd'
	},
	{
		id: 'gruvbox-dark',
		name: 'Gruvbox',
		group: 'dark',
		bg: '#282828',
		surface: 'rgba(36, 36, 36, 0.92)',
		raised: '#3c3836',
		border: '#504945',
		borderStrong: '#665c54',
		fg: '#ebdbb2',
		fgMuted: '#bdae93',
		fgDim: '#a89984',
		accent: '#fabd2f',
		accentFg: '#fe8019',
		danger: '#fb4934',
		success: '#b8bb26',
		warn: '#d79921',
		npLabel: '#8ec07c'
	},
	{
		id: 'solarized-dark',
		name: 'Solarized Dark',
		group: 'dark',
		bg: '#002b36',
		surface: 'rgba(2, 33, 41, 0.92)',
		raised: '#073642',
		border: '#0d4a57',
		borderStrong: '#0f5765',
		fg: '#93a1a1',
		fgMuted: '#839496',
		fgDim: '#657b83',
		accent: '#268bd2',
		accentFg: '#2aa198',
		danger: '#dc322f',
		dangerFg: '#e0564f',
		success: '#859900',
		successFg: '#a3bd2c',
		warn: '#b58900',
		warnFg: '#cba62f',
		npFg: '#eee8d5',
		npLabel: '#2aa198'
	},
	{
		id: 'tokyo-night',
		name: 'Tokyo Night',
		group: 'dark',
		bg: '#1a1b26',
		surface: 'rgba(22, 22, 30, 0.92)',
		raised: '#24283b',
		border: '#2f334d',
		borderStrong: '#3b4261',
		fg: '#c0caf5',
		fgMuted: '#9aa5ce',
		fgDim: '#787c99',
		accent: '#7aa2f7',
		accentFg: '#7dcfff',
		danger: '#f7768e',
		success: '#9ece6a',
		warn: '#e0af68',
		npLabel: '#7dcfff'
	},
	{
		id: 'one-dark',
		name: 'One Dark',
		group: 'dark',
		bg: '#282c34',
		surface: 'rgba(35, 39, 46, 0.92)',
		raised: '#2c313a',
		border: '#3b4048',
		borderStrong: '#4b5263',
		fg: '#abb2bf',
		fgMuted: '#9098a4',
		fgDim: '#6b7280',
		accent: '#61afef',
		accentFg: '#56b6c2',
		danger: '#e06c75',
		success: '#98c379',
		warn: '#e5c07b',
		npFg: '#dfe4ec',
		npLabel: '#56b6c2'
	},
	{
		id: 'midnight',
		name: 'Midnight',
		group: 'dark',
		bg: '#06070d',
		surface: 'rgba(8, 9, 16, 0.92)',
		raised: '#10121d',
		border: '#1d2030',
		borderStrong: '#2a2f45',
		fg: '#dfe6f5',
		fgMuted: '#a3acc6',
		fgDim: '#727b96',
		accent: '#4f7cff',
		accentFg: '#8aa6ff',
		danger: '#ff6b6b',
		success: '#5fd29a',
		warn: '#ffc14f'
	},
	// --- Fun ---
	{
		id: 'synthwave',
		name: 'Synthwave',
		group: 'fun',
		bg: '#1a0b2e',
		surface: 'rgba(26, 11, 46, 0.92)',
		raised: '#2a1145',
		border: '#3d1a63',
		borderStrong: '#52248a',
		fg: '#ffe5ff',
		fgMuted: '#d3a6e8',
		fgDim: '#a877c4',
		accent: '#ff2e97',
		accentFg: '#ff79c6',
		danger: '#ff5370',
		success: '#06f0c2',
		warn: '#ffd166',
		npLabel: '#06f0c2'
	},
	{
		id: 'matrix',
		name: 'Matrix',
		group: 'fun',
		bg: '#000805',
		surface: 'rgba(0, 12, 8, 0.92)',
		raised: '#04150e',
		border: '#0a3a26',
		borderStrong: '#0f5c3b',
		fg: '#aaffcc',
		fgMuted: '#5fcf94',
		fgDim: '#3a9c6a',
		accent: '#00ff66',
		accentFg: '#39ff88',
		danger: '#ff5555',
		success: '#00ff66',
		warn: '#d7ff5b',
		npFg: '#c6ffe0',
		font: "'JetBrains Mono', 'Consolas', monospace"
	},
	{
		id: 'bubblegum',
		name: 'Bubblegum',
		group: 'fun',
		bg: '#2a1430',
		surface: 'rgba(42, 20, 48, 0.92)',
		raised: '#3c1e44',
		border: '#572a60',
		borderStrong: '#73387f',
		fg: '#ffe6f7',
		fgMuted: '#e3a8d6',
		fgDim: '#bf7ab0',
		accent: '#ff6ac1',
		accentFg: '#ff9fd8',
		danger: '#ff5d8f',
		success: '#7af0c8',
		warn: '#ffd86b'
	},
	{
		id: 'vaporwave',
		name: 'Vaporwave',
		group: 'fun',
		bg: '#1f1147',
		surface: 'rgba(31, 17, 71, 0.92)',
		raised: '#2c1a63',
		border: '#3f2785',
		borderStrong: '#5836a8',
		fg: '#e9d5ff',
		fgMuted: '#b79de0',
		fgDim: '#8f74c0',
		accent: '#36e2ec',
		accentFg: '#7bf1f7',
		danger: '#ff6ad5',
		success: '#a6ff8f',
		warn: '#ffe66d',
		npLabel: '#ff6ad5'
	},
	{
		id: 'hacker-green',
		name: 'Hacker Green',
		group: 'fun',
		bg: '#0a0f0a',
		surface: 'rgba(8, 14, 8, 0.92)',
		raised: '#10180f',
		border: '#1c2a1a',
		borderStrong: '#2a3f27',
		fg: '#caffca',
		fgMuted: '#7fcf7f',
		fgDim: '#4f9c4f',
		accent: '#39ff14',
		accentFg: '#76ff5b',
		danger: '#ff4444',
		success: '#39ff14',
		warn: '#d7ff5b',
		font: "'JetBrains Mono', 'Consolas', monospace"
	},
	{
		id: 'sunset',
		name: 'Sunset',
		group: 'fun',
		bg: '#1c0f14',
		surface: 'rgba(28, 15, 20, 0.92)',
		raised: '#2a151c',
		border: '#42222c',
		borderStrong: '#5e3340',
		fg: '#ffe9df',
		fgMuted: '#e0a890',
		fgDim: '#bd7e66',
		accent: '#ff7b54',
		accentFg: '#ffb26b',
		danger: '#ff5470',
		success: '#9bd770',
		warn: '#ffd56b'
	},
	{
		id: 'candy',
		name: 'Candy',
		group: 'fun',
		light: true,
		bg: '#fdeef6',
		surface: '#ffffff',
		raised: '#fbe0ee',
		border: '#f3c9e0',
		borderStrong: '#e7a8cd',
		fg: '#5a2a45',
		fgMuted: '#8a4f70',
		fgDim: '#b07898',
		accent: '#e84393',
		accentFg: '#c01f72',
		danger: '#d63031',
		success: '#00b894',
		successFg: '#0a8c72',
		warn: '#e1a100'
	}
];

export const BUILTIN_THEMES: BuiltinTheme[] = SPECS.map((s) => {
	const tokens = specTokens(s);
	return {
		id: s.id,
		name: s.name,
		group: s.group,
		css: tokensToCss(tokens),
		swatch: swatchFromTokens(tokens)
	};
});

const BY_ID = new Map(BUILTIN_THEMES.map((t) => [t.id, t]));

/** Order the groups appear in the picker. */
export const BUILTIN_GROUP_ORDER: BuiltinGroup[] = ['classic', 'light', 'dark', 'fun'];

/** True when a selected-theme string names a built-in preset (starts with `builtin:`). */
export function isBuiltinName(name: string): boolean {
	return name.startsWith(BUILTIN_PREFIX);
}

/** The bare id from a `builtin:<id>` selection, or null when `name` isn't a built-in. */
export function builtinIdOf(name: string): string | null {
	return isBuiltinName(name) ? name.slice(BUILTIN_PREFIX.length) : null;
}

/** The full selection string for a built-in id (e.g. `nord` → `builtin:nord`). */
export function builtinName(id: string): string {
	return BUILTIN_PREFIX + id;
}

/** Look up a built-in by bare id. */
export function builtinById(id: string): BuiltinTheme | undefined {
	return BY_ID.get(id);
}

/** The CSS for a `builtin:<id>` selection, or null if `name` isn't a (known) built-in. */
export function builtinCss(name: string): string | null {
	const id = builtinIdOf(name);
	if (id == null) return null;
	return BY_ID.get(id)?.css ?? null;
}

/** The built-ins grouped + ordered for the picker (empty groups omitted). */
export function builtinGroups(): { group: BuiltinGroup; themes: BuiltinTheme[] }[] {
	return BUILTIN_GROUP_ORDER.map((group) => ({
		group,
		themes: BUILTIN_THEMES.filter((t) => t.group === group)
	})).filter((g) => g.themes.length > 0);
}
