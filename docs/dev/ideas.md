# Ideas

## Queued Studio refinements

Requested on 2026-10-21. Track the follow-up audits separately from the initial
Studio workspace changes.

- [x] **Templates / My widgets design-system audit and fixes.** Review both tabs in list
  and preview modes, including narrow and wide panes. Align typography, spacing, card
  captions, metadata, action placement, empty/search states, and focus/hover/selected
  states with Studio tokens and shared components. Check preview sizing, wrapping,
  overflow, and two-/three-column layouts. Validate the resulting browser interactions
  and visual layouts.
- [x] **Assistant pages copy, IA, UX, UI, and design-system overhaul.** Review the
  Assistant entry points, Your agent / Built-in tabs, connection/setup guidance,
  provider/model configuration, conversation actions, and loading/error/empty states.
  Clarify naming and hierarchy, simplify onboarding and instructions, and align
  typography, spacing, controls, and responsive layouts with the Studio design system.
  Preserve conversation drafts and history across navigation and validate keyboard
  access and the setup-to-conversation flow.

Completed: all three catalog tabs share card typography, spacing, icons, focus states,
preview sizing, and responsive grids. Templates with options use a compact card and a
separate setup dialog, with draft retention and keyboard focus restoration. Assistant
has a local loading boundary, revised connection guidance, collapsible agent/model setup,
an active-response spinner, and no duplicate pane header. Cross-tab browser checks,
dialog/keyboard checks, and the delayed-module loading regression cover these changes.

- [x] **CPU gauge endpoint alignment in the personal layout and derived templates.**
  Keep 100 and, where possible, 0 inside the reading area to avoid vertical imbalance.
  Inline charts now match the reading's capital height and baseline, with a 2 px margin
  added to the row's existing gap (about 6 px total in the current layout). The shared
  Text widget rule applies to existing layouts and the Local desktop, System monitor ·
  Inline, and Network · Inline templates. Explicit height and gap overrides remain
  available. Browser checks cover 16/20 px readings, fixed columns, and narrow network rows.
- [x] **Custom widget pane UI, UX, IA, and design-system audit and fixes.** Review the
  Custom / widget-designer workspace end to end: saved definitions and template browsing,
  create/clone/edit flows, structure tree, preview canvas, properties, parameters, and
  save/delete actions. Clarify naming, navigation, action hierarchy, guidance, and
  empty/loading/error states. Align typography, spacing, controls, cards, tabs, and
  responsive pane behavior with the Layouts catalog and shared Studio components/tokens.
  Preserve drafts and Undo, check keyboard/focus behavior, and validate narrow/wide panes
  and the create-to-preview-to-reuse journey in the browser.
  Completed: sticky search and creation controls, shared counted/persistent category
  disclosures, named row actions, an explicit Use template action, a shorter empty state,
  clearer parameter controls, and readable responsive editing/preview banners. Monitor
  navigation stays in Layouts. Browser checks cover preview → editable copy → rename →
  reuse from My widgets → Undo, filtering without losing disclosure state, and banner
  clearance at 1024 px. All 101 browser checks and 4,615 unit/component tests pass;
  required coverage is 100%, with typecheck, lint, production build and docs checks green.
- [x] **Live widget usability refinements.** Remove native monitor-input tooltips;
  separate inline download/upload groups by 48 px, larger than the visible number-to-chart
  gap; provide a copyable MCP setup prompt under Your agent; add configurable analog-clock
  line thickness and use 2 px for the small live clock and matching templates. Personal
  dev layout updates use guarded atomic writes and exact backups.
- [x] **Black flashes when switching Studio panes.** Reproduced by delaying a panel's
  module request: the shared Suspense fallback hid the entire toolbar and navigation.
  Section browsing, navigation, Details and Assistant now have independent loading
  boundaries. Slow panes retain the rest of Studio, show a loading status inside their
  own bounds, and can be left immediately. Loading surfaces also preserve canvas
  selection. Browser regressions cover delayed Background, Custom and Details modules,
  retained Assistant drafts, unchanged document navigation and a preserved toolbar.
- [x] **Remaining widget density migrations.** Continue the documented audit in
  [Widget design presets](../design-presets.md): Home Assistant controls and Stock Ticker
  first, then proportional captions and fixed gaps in the partial-support families.
  Preserve explicit widget overrides and verify all three densities in browser bounds.
  Home Assistant and Stock Ticker are migrated: semantic text/gaps, grouped controls,
  readable notices and larger defaults for new Light/Media Player widgets. The seeded
  comparison checks Compact, Comfortable and Large bounds plus explicit size overrides.
  All 19 remaining content types now use semantic text roles and density-aware gaps.
  GPU, Connections, RSS and Agenda keep complete rows in scrollable regions; AI Prompt,
  microphone and timer controls follow density targets. Existing local size overrides
  remain available. New GPU widgets have room for readable stats; old boxes keep their
  sizes. Browser checks cover all three densities, key bounds, scrolling and overrides.
  Intrinsic chart/dial geometry and author-controlled HTML/media remain intentional limits.
- [x] **Studio shell design-system audit and fixes.** Review the title bar, primary
  actions, canvas toolbar, navigation rail, workspace tabs, pane dividers, menus,
  banners and shortcut hints. Align typography, spacing, control sizes and interaction
  states with Studio tokens; verify keyboard access, narrow widths and theme contrast.
  Completed: neutral shell borders, sentence-case labels, shared control corners,
  consistent stroke icons for canvas actions, and visible Assistant selection state.
  Browser checks retain keyboard/menu behavior and verify control bounds at 980 px.
- [x] **Remaining Studio panes design-system audit and fixes.** Review Sensors,
  Plugins and integration settings, Themes/tokens, Background, Share, Saved layouts,
  and every Settings page (including MCP and Diagnostics). Reuse the established
  pane, form, tab and disclosure vocabulary. Fix hierarchy, copy, spacing, responsive
  layout, empty/error states and overflow, including when Assistant is open.
  Completed: sentence-case title roles and semantic headings, compact Settings navigation,
  selected-page semantics, wrapping shortcuts/actions, consistent integration fields,
  bounded simple forms, clearer Share/Background copy and a valid initial export name.
  MCP setup shares its tabs/cards across Settings and Your agent, with hidden methods
  correctly excluded. Reviewed all eight integration settings and all Settings pages
  beside Assistant; browser checks cover 1024/1600 px, a light theme, 125% zoom and contrast.
  Validation: 110 browser tests pass; 4,618 unit/component tests pass with 100% required
  coverage; typecheck, lint, production build and docs freshness checks pass.

Final queue validation: 114 browser tests and 4,618 unit/component tests pass, with 100%
required coverage. Typecheck, zero-warning lint, production build and generated docs checks
pass. Windows backend: 445 tests pass, 5 intentional ignores; Clippy and rustfmt checks pass.
The running native dev layout decodes with no dropped monitors or definitions. Affected widget
screenshots were refreshed. Changes remain on the working branch for review.

## Stream Deck integration

Investigation completed on 2026-10-21. Implementation remains unscheduled.

Recommended direction: a small dedicated Stream Deck plugin that reuses Widgetsack's existing
local control server. The plugin owns button/dial lifecycle, settings and feedback; Widgetsack
keeps media and Home Assistant execution in its existing backend adapters. This is an architecture
recommendation, not an implemented or hardware-tested integration.

The [official SDK environment](https://docs.elgato.com/streamdeck/sdk/v2/introduction/plugin-environment/)
provides a local Node.js application layer and a Chromium property inspector. Its
[action settings](https://docs.elgato.com/streamdeck/sdk/v2/guides/settings/) can store each
button's non-secret action configuration. [Dial events and feedback layouts](https://docs.elgato.com/streamdeck/sdk/v2/guides/dials/)
support a later encoder UI without changing the Widgetsack widget renderer.

Initial scope can use the routes already implemented in `widgetsack/src/control.rs`:

- Media play/pause, next/previous, stop and seek through `POST /media`, with an optional source.
- Configured, permitted Home Assistant services through `POST /ha`; keep the existing service restrictions.
- Now-playing text/playback feedback through `GET /now_playing` and liveness through `GET /health`.

The connection would remain opt-in. Discover the current URL and per-launch bearer token from
`<config>/mcp/control.json`; retain the token in plugin memory, and reread the descriptor after
restart or authorization failure. Action settings should contain only the target/action and
non-secret parameters. Keep all HTTP calls in the Node.js layer. A single poller should update
visible keys, stop polling when none are visible, and show an unavailable state when Widgetsack
is closed. Do not replay a failed actuation automatically: a media toggle may already have run.

MCP is the editor/agent interface and requires Studio; it need not become a dependency of physical
media buttons. The current control server has no audio-device volume, monitor-input, layout or
sensor-stream routes. Those features need explicit backend contracts before adding corresponding
Stream Deck actions. The encoder UI alone does not make them available.

Before implementation, test descriptor rotation, connection loss, stale credentials, invalid action
settings and duplicate presses with a fake HTTP server. Reuse the existing media/HA validation
seams. Reserve the final hardware smoke check for actual keys/dials, sleep/resume and feedback.
No plugin, endpoint, setting or device configuration was changed during this investigation.
