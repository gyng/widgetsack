# Theming

> **Generated** from the code that defines the system — do not hand-edit. Run `npm run gen:docs`
> (in `client/`) to regenerate. Sources of truth: `client/src/lib/core/tokens.ts` (the token
> vocabulary) and `client/src/lib/core/style.ts` (the cascade + scoping).

A **theme** is just a CSS file (`themes/<name>.css` in the app config dir). It sets a handful of CSS
custom properties (**tokens**) that every widget reads, so one small file restyles all your widgets
without touching any widget. Pick, edit, duplicate, and delete themes from the studio's **Themes**
section; the active theme + any token overrides are saved with your layout and travel inside a shared
**sack**.

> A theme recolours both the **widgets** (via `--np-*` tokens) and the studio's own **chrome** — the
> title bar, rails, and panels — via separate `--ui-*` tokens, so a light theme yields a light studio.
> Set whichever you want; a widgets-only theme just leaves the `--ui-*` tokens at their defaults.

## Tokens

Set these at `:root` in a theme to recolour every widget. Their defaults are the built-in look — a
theme only needs to set the ones it changes; anything it omits falls back to the default below.

| token | default | purpose |
| --- | --- | --- |
| `--np-accent` | `rgb(119, 196, 211)` | Primary fill / line / accent (gauges, bars, sparklines, active states). |
| `--np-fg` | `#ffffff` | Main text and numerals. |
| `--np-muted` | `rgba(255, 255, 255, 0.6)` | Secondary text (units, sub-labels). |
| `--np-label` | `rgb(218, 237, 226)` | Labels above/below a value. |
| `--np-track` | `rgba(255, 255, 255, 0.15)` | The unfilled track behind a gauge / bar. |
| `--np-bg` | `rgba(10, 10, 12, 0.6)` | Widget chrome background (e.g. a button surface). |
| `--np-danger` | `#e5484d` | Error / invalid / over-threshold state. |
| `--np-warn` | `#e2a03f` | Warning / caution state. |
| `--np-success` | `#3fb950` | OK / healthy state. |
| `--np-accent-up` | `#3fb950` | A rising value (market ticker up, positive delta). |
| `--np-accent-down` | `#f85149` | A falling value (market ticker down, negative delta). |
| `--np-font` | `'Bahnschrift', 'Arial Narrow', sans-serif` | Body font family. |
| `--np-font-display` | `'Bahnschrift', 'Arial Narrow', sans-serif` | Display font family (large numerals / headings). |
| `--np-radius` | `2px` | Corner radius for widget chrome. |
| `--np-gap` | `4px` | Default gap between elements inside a widget. |
| `--np-control-size` | `28px` | Minimum target size for compact interactive controls. |
| `--np-touch-target` | `44px` | Minimum target size for large, touch-first controls. |

## Chrome tokens (the editor itself)

The studio chrome — title bar, rails, panels, backgrounds — is themeable too. A theme sets these
`--ui-*` tokens at `:root` alongside the widget tokens above, so picking a light theme yields a
light studio. Their dark defaults live in `client/src/styles.css`; a theme only sets what it changes.
Accent / state colours are RGB **channels** (e.g. `--ui-accent-rgb: 119, 196, 211`) so both the solid
`rgb(var(--ui-accent-rgb))` and translucent `rgba(var(--ui-accent-rgb), a)` forms work.

Beyond colour, the chrome's **density and typography** ride the same system: the `--space-*` scale,
`--text-*` type ramp, `--radius-*` shapes, `--control-h`, and `--disabled-opacity` below are plain
`:root` custom properties — a theme can compact the studio (`--space-3: 4px; --text-md: 10px`) or
relax it the same way it recolours it.

| token | purpose |
| --- | --- |
| `--ui-bg` | Base window + opaque panel background. |
| `--ui-surface` | Translucent rails / docked panels. |
| `--ui-bar-bg` | Top / sub / bottom bars (incl. the title bar). |
| `--ui-raised` | Inputs, buttons, raised rows. |
| `--ui-scrim` | Menu / modal backdrops. |
| `--ui-fg` | Primary chrome text. |
| `--ui-fg-muted` | Secondary chrome text. |
| `--ui-fg-dim` | Tertiary chrome text (== the legacy --dim-fg). |
| `--ui-border` | Hairline borders / dividers. |
| `--ui-border-strong` | Stronger control borders. |
| `--ui-accent-rgb` | Chrome accent as "r, g, b" channels (rgb()/rgba() forms). |
| `--ui-accent-fg` | Bright accent text / icons / active labels. |
| `--ui-danger-rgb` | Destructive accent channels. |
| `--ui-danger-fg` | Destructive text. |
| `--ui-success-rgb` | Success accent channels. |
| `--ui-success-fg` | Success text. |
| `--ui-warn-rgb` | Warning accent channels. |
| `--ui-warn-fg` | Warning text. |
| `--space-1` | Spacing scale: hairline (2px). |
| `--space-2` | Spacing scale: tight (4px). |
| `--space-3` | Spacing scale: default gap (6px). |
| `--space-4` | Spacing scale: section / panel inset (8px). |
| `--space-5` | Spacing scale: large (12px). |
| `--space-6` | Spacing scale: screen-edge / panel padding (16px). |
| `--text-xs` | Type scale: smallest annotations (9px). |
| `--text-sm` | Type scale: section headers / hints (10px). |
| `--text-md` | Type scale: chrome body (11px). |
| `--text-lg` | Type scale: emphasized body / panel text (12px). |
| `--text-xl` | Type scale: panel titles (14px). |
| `--radius-control` | Corner radius for inputs / buttons / chips (2px). |
| `--radius-panel` | Corner radius for panels / cards / menus (4px). |
| `--control-h` | Minimum height of rail/bar inputs and selects (22px). |
| `--disabled-opacity` | Opacity of disabled controls (0.5). |

## Built-in themes

The picker ships a library of immutable presets, grouped. Pick one, or **duplicate** it (⎘) to start a
new editable theme of your own. Built-ins are selected as `builtin:<id>` and defined in
`client/src/lib/core/builtinThemes.ts`.

- **Classic** — App, Mono, Amber, Slate, Steel
- **Light** — Paper, Solarized Light, Nord Light, Daylight, Mint Light, Linen
- **Dark** — Nord, Dracula, Gruvbox, Solarized Dark, Tokyo Night, One Dark, Midnight
- **Fun** — Synthwave, Matrix, Bubblegum, Vaporwave, Hacker Green, Sunset, Candy

## How a theme is applied

The studio assembles one stylesheet per monitor, in cascade order (later wins):

1. **The token defaults** — the table above, emitted at `:root` so every `var(--np-*)` resolves.
2. **The active theme**, verbatim — your `:root { --np-accent: … }` overrides, plus any custom rules.
3. **Token overrides** — the friendly fields in the Themes/Inspector panels, layered on top of the
   theme (they win until you press **Clear overrides**, and they persist across theme switches).
4. **Per-widget-type CSS**, scoped to `[data-def="<id>"]` (styles every instance of a designed widget).
5. **Per-instance / per-group CSS**, scoped to `[data-w="<id>"]` / `[data-group="<id>"]` (most specific).

### Authoring CSS beyond the tokens

The theme editor (Themes → ✎, or "Edit theme CSS…") is a full CSS editor. Beyond setting tokens you
can target the stable widget hooks (`[data-w]`, `[data-def]`, `[data-group]`, and the meters'
`np-*` classes). A per-widget or per-def CSS block is scoped automatically.

> **Scoping caveat:** `@font-face` and `@keyframes` **cannot** be nested, so they only work in the
> **global theme** file — not in a per-widget / per-def CSS block (there they're silently dropped).
> Put shared fonts and keyframes in the theme.

### Fonts

Name a font via the `--np-font` / `--np-font-display` tokens **or** any `font-family:` in your theme
CSS, and the studio loads it automatically (it scans the assembled stylesheet and `@font-face`s each
concrete family). A font referenced only by raw CSS still loads — you don't need to register it.

## Sharing & safety

A sack bundles your widget library + the active theme CSS + token overrides into one JSON file. Theme
CSS is injected with full access to the studio, so on import a sack's theme is **scanned** for
constructs that reach outside the app — remote `url(...)` / `@import` (which could phone home) and
full-screen overlays — and you're asked to confirm before trusting a stranger's theme.
