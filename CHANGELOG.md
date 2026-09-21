# Changelog

Notable changes per release. Older releases are described by their auto-generated notes on the
[GitHub releases page](https://github.com/gyng/widgetsack/releases).

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

- **Update notification.** The app now checks GitHub for a newer release shortly after start and every
  six hours, shows it in the tray ("Update available: vX"), as a badge on the studio's Settings entry,
  and on the About tab with an "Open release page" button. No automatic download or install.
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
