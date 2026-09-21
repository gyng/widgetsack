# Changelog

Notable changes per release. Older releases are described by their auto-generated notes on the
[GitHub releases page](https://github.com/gyng/widgetsack/releases).

## 0.0.60

### Changed — studio UX round

- **Building a dashboard works on the first try.** After adding a widget into a container the palette
  keeps targeting that container (a chip shows "Adding into: row ✕"); new widgets land in the first
  free spot instead of stacking at one corner, and flash into view; an empty Text widget shows a
  placeholder while editing; an empty monitor shows a three-step card, and first boot a dismissible
  strip; selecting a container shows its properties first with an "Add into this container" button.
- **Overlay edit mode (Ctrl+Alt+E on the desktop) now matches the studio:** monitor badge, shortcut
  bar, Revert, a correct exit hint, and an alert when a write fails.
- **Undo/labels/forms:** selects show their default ("arc (default)"); colour fields use the colour
  picker; the sensor field commits on blur/Enter as one undo step and warns about unknown ids; widget
  config forms are grouped (Data / Appearance / Behaviour) and every field has help; the Monitor Switch
  volume device is hidden unless the target is system.
- **Keyboard and sizing:** one tab stop per widget, keyboard-navigable Outline with hover-revealed
  actions, larger resize handles and buttons, 12 px base UI text, Ctrl+9 for Settings, align and
  distribute for floating widgets, theme editor guards unsaved edits and traps focus, "Zoom to content".
- **Vocabulary:** custom widget (not def), Background (not backdrop/wallpaper), monitor (not display),
  Save (not save draft), Ungroup (not Unlink), Presets, Shortcuts, "Behind desktop icons" for the
  wallpaper layer, lowercase "widgetsack" everywhere; raw ids and devtools items are behind a new
  Developer mode toggle (Settings → Diagnostics).
- **Failures are visible:** each studio section has its own error boundary; a corrupt widgets.json shows
  a banner with the backup path; sack import reports what merged and export failures are shown; inline
  forms replace browser prompts for export, package install, rename, and presets; launch-at-login
  failures are explained; Home Assistant tiles say "not configured" / "offline" / "entity unavailable";
  Weather says where to set a location; Monitor Switch explains an unsupported monitor.
- README and docs describe the current tray menu and the Ctrl+Alt+E / Ctrl+Alt+Shift+E shortcuts.
- **Also changed, worth knowing after upgrading:** nav rail sections are Layout / Custom / Share /
  Presets (were Layouts / Defs / Sacks / Saved layouts) and Settings tabs are Monitor / Shortcuts;
  the header ⋯ "Export sack…" opens the Share section; the sensor field is hidden for widgets that
  source themselves (clock, calendar, button, cpu, battery, gpu, disks, …); Home Assistant tiles hide
  their controls (not just the value) while offline / unconfigured / unavailable; the Outline's
  per-row move buttons live in a hover "⋯" menu (Alt+Arrow moves rows) and containers collapse; the
  tray items read "Re-fit overlays to monitors" and "Launch at login"; Monitor Switch volume with a
  chosen output that has since been unplugged falls back to the default output (logged).

### Added

- **Monitor Switch: choose which Windows output the system volume applies to.** With `volume target
  = system`, a new `volume device` picker selects the output whose volume a source's `@NN` sets
  (blank = whatever is the default output at the time). The volume command now accepts an optional
  device id.

### Fixed

- **Upgrading from a pre-0.0.53 layout no longer strands a monitor's widgets when the saved window
  state is stale.** The one-shot monitor-key migration used a saved overlay window's geometry as the
  only route for that monitor, so a layout re-keyed to the monitor's *current* GDI name after Windows
  re-numbered displays (while `.window-state.json` still named the old one) was left under its legacy
  key and the monitor came up empty. Both routes now apply; when a file carries a layout under each,
  the geometry-backed key wins. The log's "legacy key mapping" line marks which keys came from
  window geometry.

## 0.0.59

### Changed

- **Monitor Switch: the paired volume now targets a selectable output, and is OFF by default.** A new
  `volume target` setting on the widget chooses what a source's `@NN` volume changes: `off` (default —
  paired volumes are ignored entirely), `system` (the Windows master volume, applied after a successful
  switch, e.g. turn the PC down when the screen goes to a console), or `monitor` (the monitor's own
  speakers over DDC/CI, sent just before the switch). 0.0.58 applied the monitor speaker volume
  unconditionally whenever a source carried one.

## 0.0.58

### Added

- **Monitor Switch: per-source volume.** Each input source can carry an optional monitor speaker
  volume (0–100) that is applied over DDC/CI (VCP 0x62) just before switching to that input, e.g.
  `0x12=NS2@35` in the `sources` spec, or the new volume field beside each source in the studio's
  source editor. The volume is sent first because the monitor may stop answering the PC's cable once
  it has switched to the other device; a rejected volume change never blocks the switch.

## 0.0.57

### Security

- **Imported layouts are scanned and sandboxed.** A shared `.sack` file, a plugin package's templates, or
  an AI-assistant layout operation could carry an unsandboxed interactive iframe, remote tracking images,
  per-widget CSS that escaped its scope, or button macros hiding Home Assistant calls, with no prompt. Every
  import now goes through one consent summary that lists iframes, remote images and backgrounds, button
  macros and CSS threats; iframes from imported trees are forced into the sandbox; CSS that would escape
  its scope wrapper is dropped; the CSS threat scanner sees through comments and escapes; and assistant
  layout operations are validated against each widget's config schema.
- **Prototype pollution closed.** A def parameter whose target walked into `__proto__` could poison the
  whole editor from one shared sack; path walks now refuse those segments everywhere (params, template
  scopes, the formula sandbox scope).
- **Stored API keys can no longer be sent to an arbitrary URL.** The LLM model-list and test-connection
  commands are studio-only and require an explicit key whenever the base URL differs from the saved one
  or certificate checks are disabled; base URLs must be https (http only for localhost).
- **Navigation and CSP hardening.** The top-level webview refuses navigation away from the app; images
  and frames are https-only; `base-uri`, `form-action` and `object-src` are locked; the asset scope is
  narrowed to wallpapers and fonts.
- The calendar feed URL (a bearer secret for private calendars) is stored encrypted and never echoed
  back; feed, calendar and album-art downloads are size-capped; agent control refuses lock unlock/open
  and alarm disarm/arm services; package fetches require the package to be enabled and refuse local and
  internal hosts. The plugin docs now describe the real trust model.

### Fixed

- **Stale "now playing" after the player quits.** A late media update arriving after the session was
  removed resurrected a phantom session that kept the widget alive and pinned the cover art.
- **Spectrum capture kept running** (WASAPI loopback and FFT) after an overlay window was destroyed; it
  also pauses while the window is hidden.
- `np.playing`, `np.status`, `np.position`, `np.progress`, `np.shuffle` and `np.repeat` reflected the
  last track change rather than live play/pause/seek state.
- The AI briefing could silently miss demand-gated sensors (GPU, top processes) on the overlay; the
  Transcribe widget could leave the microphone open if it unmounted mid-permission-prompt.
- Home Assistant state changes are batched (one bridge message per 250 ms) and only forwarded for
  entities a window actually binds, with late binders primed from a cache.
- Self-discovering meters (Disks, CPU cores) drop ids that stopped reporting, so an ejected drive no
  longer shows a stale value forever.
- Sparkline renders to a canvas instead of rewriting SVG points every tick (the pattern behind
  long-running overlay memory growth).
- Clocks, countdowns, timers and calendars share one boundary-aligned timer per window (no seconds
  skipping); the Volume widget polls every 3 s and pauses while hidden.
- **Studio:** rubber-band selection works from any empty point inside the monitor again (it only worked
  from the gutter); undo after a cross-monitor move no longer duplicates the widget on save; theme, token
  and lock changes are undoable; typing and key-repeat nudges coalesce into one undo step; measurement no
  longer rebuilds observers on every drag frame or meter tick; click-through rects refresh when a theme
  reveals controls; a single bad monitor entry no longer replaces the whole layout with the demo (the
  layout is backed up and the affected monitor loads empty); overlay edit mode debounces and serialises
  disk writes; the studio detects external layout changes ("Reload / Keep mine") instead of clobbering
  them; switching monitors can no longer write an empty layout under the new key; the header menu and
  context menus are keyboard-navigable and widgets are selectable from the keyboard; the Save button
  copy now says edits preview live on the overlays.
- Docs: the Clock format help describes the real (moment-style) tokens; Spectrum device/scale are
  documented as app-wide; the generated widget reference now covers plugin widgets too.

## 0.0.56

### Fixed

- **Overlays of a monitor that was switched away, or that became the primary, are now closed.** The
  reconcile pass only walked the monitors it could still see, so an overlay whose monitor vanished was
  relocated by Windows onto another screen (or lingered invisibly holding a renderer), and when the
  primary went away and another monitor took over, that monitor's own overlay stacked on top of the
  primary window. Reconcile is now a set difference: exactly one overlay per connected, non-primary,
  populated monitor. A secondary whose monitor is absent hides itself instead of being relocated.
- **Refits no longer fight each other or reset presentation.** DPI/scale changes go through the same
  single-flight refit as the display poller and the tray trigger; the spawn-side fit (a second
  concurrent fitter that leaked a scale listener per respawn) is gone; and a refit re-applies the
  current presentation, so a topology tick no longer turns an overlay in edit mode click-through or
  strips a windowed-debug window back to borderless.
- **Close-then-recreate of the same overlay within a second** (remove the last widget on a monitor,
  add one back) could leave the overlay missing until the next layout change; overlays are now
  destroyed and waited for, and a "label already exists" spawn error retries the reconcile.
- **Wallpaper layer**: fits un-parent from the desktop for the move (a parented window is positioned
  parent-relative, which put it on the wrong screen on multi-monitor setups), and re-parenting is
  skipped when already parented, so a refit no longer round-trips through the shell on the UI thread.
- **Layout-key migration** matches saved overlay windows by position and size with a small tolerance
  (the DPI-hop inflation), so two same-size monitors are told apart and an inflated save still
  identifies its monitor; overlay geometry is flushed to disk when an overlay closes (not only on a
  clean exit), and the log records which evidence decided each mapping.
- **Empty layout everywhere** no longer boots and tears down a renderer every 30 s: the primary tells
  the backend why it is going down, and the keep-alive retry stretches to 10 minutes.
- Interactive click-through rects are dropped when their window is destroyed (the cursor watcher
  could never idle again), and a duplicated display no longer flips its stable key between
  enumerations.
- **UI-thread stalls removed.** Core Audio calls (volume widget, audio switcher; polled every
  second), the system-font scan (now cached), foreign-window snapping (hung targets are refused),
  client log writes, and the DPAPI-backed config-status reads all ran on the UI thread and could block
  it during a display or audio-device change; they now run on worker threads with timeouts.
- **Layout saves no longer echo through the file watcher**: a save emitted up to three reloads to
  every window and could respawn the primary per save when editing a secondary with the studio closed.
  The app's own writes are recognised and ignored, and external edits are coalesced.
- **MQTT** could deadlock on subscribe with many topics or a retained-discovery burst; subscriptions are
  now queued non-blocking, oversized or non-UTF-8 payloads are dropped, and the topic catalog is bounded.
- **Home Assistant** connections now time out (connect, idle, and a 30 s heartbeat), so a half-open
  socket after sleep or a network change no longer freezes every HA widget for minutes.
- Sensor sampling runs off the async runtime with an overrun guard (no burst of missed ticks after a
  stall), and the MCP state snapshot is written atomically.
- Log writes go through a dedicated thread with a bounded queue (bursts are counted, not blocking), the
  panic hook can no longer deadlock inside the event machinery, and the update check reports GitHub
  rate limiting clearly.

### Added

- **Update notification (opt-in, off by default).** Settings → About → "check for updates
  automatically" makes the app ask GitHub for a newer release shortly after start and every six hours,
  and show it in the tray ("Update available: vX"), as a badge on the studio's Settings entry, and on
  the About tab with an "Open release page" button. Nothing is downloaded or installed automatically,
  and nothing is polled unless you turn it on; the manual "Check for updates" button always works.
- **Diagnostics: logs pane, copy diagnostics, log folder.** The Diagnostics tab shows the app log
  (level and target filters, quick chips for the watchdog, display changes, and overlay refits), a
  "Copy diagnostics" button that composes a report (version, monitors with stable keys, process
  snapshot, and the relevant log lines) for bug reports, the log file path, and an "Open log folder"
  button.
- CI checks that the version in `tauri.conf.json`, `Cargo.toml`, and the release tag agree and that
  the changelog has a section for it; the release build now attaches assets to a draft before the
  release is published (see `docs/development.md`).

## 0.0.55

### Fixed

- **Primary overlay could reveal early with placeholder widgets at boot** (regression in 0.0.54). The
  new drift check ran on the display poller's very first tick, before the primary window's initial
  fit, so it reported the not-yet-fitted boot window as drifted and started a second refit racing
  startup. The first tick now only records the baseline. The poller also no longer stacks ticks
  while the main thread is busy.

## 0.0.54

### Fixed

- **Overlay 8 px off after being spawned across a DPI boundary.** A secondary overlay is created from
  the primary's webview (on the primary monitor) and then moved to its own monitor; when the two
  differ in scale, Windows re-places the window with a suggested rect that assumes the resize frame
  the app hides, leaving it inflated by 8 px on every side (widgets clipped at the top/left). The
  scale-change listener that would have re-fitted it was registered only after the move, so the event
  could be missed and the window stayed off until restart. The listener is now wired before the fit,
  and the display poller also checks each overlay against its monitor every few seconds and refits on
  drift, so no OS re-placement can stick.

## 0.0.53

### Fixed

- **Layouts follow the physical monitor, not its `\\.\DISPLAYn` number.** Windows re-numbers displays
  whenever they re-enumerate (a primary switched to another HDMI input and back, sleep/wake), and layouts
  were keyed on that number, so a whole monitor's widgets could come back on a different screen. Layouts,
  overlay windows and Monitor Switch targets are now keyed on the monitor's stable identity (EDID hardware
  id + connector, the same identity Windows keys its own per-monitor settings on). Existing layouts are
  migrated once on first launch; when the numbers have already been shuffled, the saved overlay window
  sizes are used to put each layout back on the monitor it was designed for.
- **Overlays no longer end up a few pixels off (widgets clipped at a monitor edge) after a display
  change.** Every fit now reads the window geometry back and re-applies it if the OS moved it (a DPI hop
  between monitors, or Windows relocating the window during an input switch), a burst of display changes
  collapses into one refit, and the taskbar inset is refreshed after every refit.
- **Less main-thread work during a display change**, the moment the app hung on 2026-09-18: the overlay
  layer no longer re-parents an already top-level window on every refit, display-name and window
  enumeration run off the UI thread, and the Monitor Switch widget no longer stacks DDC reads while a
  monitor is mid input-switch.
- Monitor Switch: pressing a source button no longer flashes a vertical scrollbar.

### Added

- **Hang diagnostics in the log file** (`widgetsack.log`): a main-thread watchdog logs when the UI thread
  stops answering and for how long, and display-topology changes and every overlay refit are logged
  with timings, so a future hang can be attributed from the log rather than only from Windows Error
  Reporting.
