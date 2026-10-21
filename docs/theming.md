# Themes

<!-- Generated from the theme catalog and token definitions. -->

Use a theme to change widget colors, fonts, and spacing.

## Select a theme

1. Open **Themes** in Studio.
2. Select a theme from the catalog.

The app applies and saves the selection automatically.

## Edit theme CSS

1. Open **Themes** in Studio.
2. Select **Duplicate** on a built-in theme to create an editable copy.
3. Edit the CSS in the dialog.
4. Select **Save & apply**.

For an existing custom theme, select its **Edit CSS** button to open the dialog.
Built-in themes are read-only.

To set a different theme for each monitor, clear **apply theme to all monitors** in **Settings → Monitor**.
Select a monitor in **Layout**, then choose its theme.

A theme is a CSS file. It can change widget styles and the Studio interface.
Use widget tokens for widgets. Use Studio tokens for the editor.

## Widget tokens

A token is a named CSS value. Set tokens inside a `:root` rule in the theme editor.
For example:

```css
:root {
  --np-accent: #77c4d3;
  --np-font: 'Bahnschrift', sans-serif;
}
```

Set only the values you want to change. Other tokens keep the defaults below.

| token | default | purpose |
| --- | --- | --- |
| `--np-accent` | `rgb(119, 196, 211)` | Gauge fills, chart lines, and selected states. |
| `--np-fg` | `#ffffff` | Main text and numerals. |
| `--np-muted` | `rgba(255, 255, 255, 0.6)` | Secondary text (units, sub-labels). |
| `--np-label` | `rgb(218, 237, 226)` | Labels above or below a value. |
| `--np-track` | `rgba(255, 255, 255, 0.15)` | The unfilled part of a gauge or bar. |
| `--np-bg` | `rgba(10, 10, 12, 0.6)` | Widget background. |
| `--np-danger` | `#e5484d` | Errors and readings above a threshold. |
| `--np-warn` | `#e2a03f` | Warning state. |
| `--np-success` | `#3fb950` | Normal state. |
| `--np-accent-up` | `#3fb950` | A rising value (market ticker up, positive delta). |
| `--np-accent-down` | `#f85149` | A falling value (market ticker down, negative delta). |
| `--np-font` | `'Bahnschrift', 'Arial Narrow', sans-serif` | Body font family. |
| `--np-font-display` | `'Bahnschrift', 'Arial Narrow', sans-serif` | Display font family (large numerals and headings). |
| `--np-radius` | `2px` | Widget corner radius. |
| `--np-widget-bg` | `transparent` | Optional common widget surface, controlled by design style presets. |
| `--np-widget-shadow` | `none` | Common widget inset border and shadow; none in Transparent style. |
| `--np-gap` | `4px` | Default gap between elements inside a widget. |
| `--np-text-caption` | `12px` | Supporting widget text size (labels, units, metadata). |
| `--np-text-body` | `14px` | Compact content-widget body size. |
| `--np-text-heading` | `16px` | Content-widget heading size. |
| `--np-line-caption` | `16px` | Supporting widget text line height. |
| `--np-line-body` | `20px` | Content-widget body line height. |
| `--np-line-heading` | `22px` | Content-widget heading line height. |
| `--np-row-gap` | `8px` | Space between related content-widget rows. |
| `--np-control-size` | `28px` | Minimum target size for compact interactive controls. |
| `--np-touch-target` | `44px` | Minimum size of large touch controls. |

## Studio tokens

Use these tokens to change Studio colors, spacing, and text sizes.
Set them inside the theme's `:root` rule.

RGB tokens contain three channels, such as `--ui-accent-rgb: 119, 196, 211`.
Use them with `rgb()` or `rgba()` in CSS.

| token | purpose |
| --- | --- |
| `--ui-font` | Studio font family. |
| `--ui-font-mono` | Code, expressions, and identifiers. |
| `--ui-font-weight` | Studio body and control weight (450 by default). |
| `--ui-bg` | Window and panel background. |
| `--ui-surface` | Sidebar and docked panel backgrounds. |
| `--ui-bar-bg` | Toolbar, title bar, and status bar backgrounds. |
| `--ui-raised` | Inputs, buttons, raised rows. |
| `--ui-scrim` | Menu and dialog backgrounds. |
| `--ui-fg` | Primary Studio text. |
| `--ui-fg-muted` | Secondary Studio text. |
| `--ui-fg-dim` | Dimmed Studio text. |
| `--ui-border` | Borders and dividers. |
| `--ui-border-strong` | Stronger control borders. |
| `--ui-accent-rgb` | Studio accent as three RGB channels. |
| `--ui-accent-fg` | Selected text, icons, and labels. |
| `--ui-danger-rgb` | Destructive accent channels. |
| `--ui-danger-fg` | Destructive text. |
| `--ui-success-rgb` | Success accent channels. |
| `--ui-success-fg` | Success text. |
| `--ui-warn-rgb` | Warning accent channels. |
| `--ui-warn-fg` | Warning text. |
| `--space-1` | Spacing scale: hairline (2px). |
| `--space-2` | Spacing scale: tight (4px). |
| `--space-3` | Spacing scale: default gap (6px). |
| `--space-4` | Spacing scale: section and panel inset (8px). |
| `--space-5` | Spacing scale: large (12px). |
| `--space-6` | Spacing scale: screen edge and panel padding (16px). |
| `--space-7` | Spacing scale: major sections (24px). |
| `--space-8` | Spacing scale: structural separation (32px). |
| `--text-xs` | Type scale: annotations (12px). |
| `--text-sm` | Type scale: labels and hints (12px). |
| `--text-md` | Type scale: Studio body (14px). |
| `--text-lg` | Type scale: section headings (16px). |
| `--text-xl` | Type scale: panel titles (20px). |
| `--line-caption` | Caption line height (16px). |
| `--line-body` | Body line height (20px). |
| `--line-heading` | Heading line height (22px). |
| `--line-title` | Title line height (26px). |
| `--radius-control` | Corner radius for inputs, buttons, and chips (4px). |
| `--radius-panel` | Corner radius for panels, cards, and menus (6px). |
| `--control-h` | Minimum height of inputs and selects (32px). |
| `--disabled-opacity` | Opacity of disabled controls (0.5). |

## Built-in themes

Select a built-in theme from the catalog below.
Built-in themes are read-only. Use **Duplicate** to create a copy you can edit.

- **Classic** — App, Mono, Amber, Slate, Steel
- **Light** — Paper, Solarized Light, Nord Light, Daylight, Mint Light, Linen
- **Dark** — Nord, Dracula, Gruvbox, Solarized Dark, Tokyo Night, One Dark, Midnight
- **Fun** — Synthwave, Matrix, Bubblegum, Vaporwave, Hacker Green, Sunset, Candy

## Style priority

The CSS cascade combines these style layers. The app loads them in this order.
CSS selector specificity and inheritance also determine which value applies.
For equal selectors and importance, later declarations take priority.

1. Built-in defaults.
2. The selected theme.
3. Global token overrides from Themes.
4. Styles saved with a custom widget.
5. Token overrides and CSS on individual widgets or groups.

Global token overrides stay active when you change themes.
Use the **Clear overrides** control in Themes to remove them.
The control label includes the number of overrides.
Inspector overrides apply to the selected widget or group only.

## Widget CSS

Select a widget to edit its CSS in the Inspector.
Use `&` to target the widget itself. Rules apply only to the selected widget.
For example:

```css
& {
  opacity: 0.8;
}
```

Put `@font-face` and `@keyframes` rules in the theme file.
These rules do not work in individual widget CSS.
The [developer theming guide](dev/theming.md) explains selectors and style assembly.

## Fonts

Select an installed font in the theme settings, or set `font-family` in CSS.
The `--np-font` token controls body text. The `--np-font-display` token controls larger readings and headings.

## Sharing themes

A sack can include widget definitions, theme CSS, and token settings.
Review the import message before you accept a shared theme.
The app scans theme CSS for remote resources and rules that can cover the window.
Only import themes from sources you trust.
