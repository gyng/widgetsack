# Changelog

Notable changes per release. Older releases are described by their auto-generated notes on the
[GitHub releases page](https://github.com/gyng/widgetsack/releases).

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
