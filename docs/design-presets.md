# Widget design presets

Choose a **Style** and a **Density** in **Themes → Tokens**, then select **Apply design preset**.
The same picker is available under a selected widget or group's **Override theme** controls.
Global presets affect widgets that inherit those tokens; a widget or group preset affects its own scope.
Each application is one undoable edit. Save to keep it.

| Style       | Use                                                        |
| ----------- | ---------------------------------------------------------- |
| Transparent | Unframed desktop readings. Keeps the active theme palette. |
| Instrument  | A subtle surface, thin inset border, and small corners.    |
| Soft        | Rounded surfaces and a gentle shadow for standalone cards. |

| Density     | Readings | Captions | Body line | Control target |
| ----------- | -------- | -------- | --------- | -------------- |
| Compact     | 14 px    | 12 px    | 20 px     | 28 px          |
| Comfortable | 16 px    | 14 px    | 24 px     | 32 px          |
| Large       | 20 px    | 18 px    | 32 px     | 44 px          |

Style and density are independent of the colour theme and the widget's Compact/Minimal content layout.
Use Transparent + Large for readable, unframed meter rows. A clock or other display reading can keep its larger size.

Manual token overrides are kept by default. Values managed by a previous preset update when you choose another preset.
Enable **Replace matching token overrides** to replace manually set values for the selected style and density.
Unrelated tokens, including your accent colour, remain unchanged.

Presets do not resize existing widget boxes or replace explicit widget CSS. Some older meters have their own size settings.
Check the preview and verify the layout after increasing density; resize fixed boxes when necessary.

Agents receive the style and density catalog from `studio_read` and can use:

```json
{
  "op": "applyDesignPreset",
  "id": "your-widget-or-group",
  "style": "transparent",
  "density": "large"
}
```

Set `replace: true` only when replacing matching token overrides is intended. Use `studio_verify` after applying.
Custom HTML widgets receive the resolved theme tokens through their widget bridge.

## Widget support audit

The 58 registered widget types were reviewed in October 2026. Every widget host supports
the style surface, radius and shadow. Density also supplies the host's base font, so relative
`em` sizes follow Compact / Comfortable / Large. Explicit widget CSS and widget-specific
size tokens still take precedence. Fixed boxes do not grow automatically.

| Widgets                                                                                                                                                                                         | Density and style support                                                                                                                                        | Remaining work or intentional limits                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text, Bar, Button / Macro, CLI Command, AI Assistant, AI Usage                                                                                                                                  | Semantic text tokens; tools use the theme font, body line height, gaps and control target. Tool surfaces follow the selected style.                              | Bar/gauge geometry and authored button boxes retain their configured size.                                                                                                                                            |
| Status / Alerts, Service Health, Task Checklist, Sensor History, App Audio / Microphone                                                                                                         | Shared semantic body, heading and caption tokens. Form controls use the density's control target and radius; gaps and history warning bands use semantic tokens. | Mixer columns and chart geometry still have fixed dimensions. Checkbox/range geometry stays native.                                                                                                                   |
| Audio Switcher, Monitor Switch, Volume, Battery                                                                                                                                                 | Body/caption tokens with existing `--as-*`, `--ms-*`, `--vol-*`, `--bat-*` overrides preserved. Switchers use the density's control target.                      | Device/input count and authored box height can require resizing.                                                                                                                                                      |
| Calendar, GPU, Disks, Top Process, Process Watcher, Connections, Ping, Wi-Fi, Recycle Bin, Sticky Note, Countdown, Timer, Weather, Sun & Moon, RSS, Agenda, AI Briefing, Transcribe / Translate | Relative typography now inherits the density's base font. Existing colour and widget-specific tokens remain available.                                           | **Partial:** many captions remain proportional `em` sizes rather than the shared caption token; internal gaps and icon sizes remain widget-specific.                                                                  |
| Air Quality                                                                                                                                                                                     | Relative text inherits density; foreground, labels and accent overrides work.                                                                                    | **Partial:** severity bands retain their dedicated fixed palette, overridable with `--aq-accent`.                                                                                                                     |
| All 11 Home Assistant types; Stock Ticker                                                                                                                                                       | Theme colours/fonts and host surfaces work.                                                                                                                      | **Partial:** fixed text sizes and internal spacing still need a dedicated migration, with box-size and control-layout checks.                                                                                         |
| Gauge, Clock, Analog Clock, CPU, Sparkline, Spectrum, Zone                                                                                                                                      | Theme colours/fonts and host surfaces work where relevant.                                                                                                       | Intrinsic SVG/canvas coordinates, dial marks and chart axes are intentionally independent of body density. Digital Clock keeps its display size; its caption follows density. CPU uses its own chart layout settings. |
| Now Playing, Custom HTML                                                                                                                                                                        | Theme tokens are available to authored CSS; Custom HTML receives resolved tokens in its frame.                                                                   | **Author-controlled:** existing Now Playing CSS or custom HTML can set explicit sizes/surfaces. Use semantic tokens when writing new widgets.                                                                         |
| Web Frame, Image, Spacer                                                                                                                                                                        | Host surfaces and geometry work.                                                                                                                                 | External pages and image pixels cannot inherit typography. Spacer has no text.                                                                                                                                        |

The next migration should address Home Assistant and Stock Ticker first, then replace relative
captions and fixed gaps in the partial families. Keep intrinsic chart/dial labels separate from
body typography, and check real browser bounds at each density before changing fixed boxes.

## AI Usage templates

The picker contains three distinct starting layouts: **Minimal quotas**, **Compact quotas**,
and **Detailed activity**. Remaining percentages are the default in all three; a separate
remaining-allowance template is unnecessary. The comparison demo and duplicate generic panel
have been removed from the picker. Existing saved widgets keep their stored content and settings.

Compact follows the live 380 × 112 sidebar: Codex session/week, Claude week, rate/ETA, reset
countdowns and available banked resets. Provider icons and continuation-line grouping follow
the same spacing as the live widget. It inherits the chosen density; **Transparent + Large**
matches the current readable sidebar. Minimal stays quota-only; Detailed includes activity graphs.
