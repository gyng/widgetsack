# Window zones

A Zone widget defines an area for an application window.
It shows an outline in Studio and stays hidden on the overlay.

## Create a zone

1. Open **Layout** in Studio.
2. Select the monitor for the zone.
3. Select **Add**.
4. Add a **Zone** widget.
5. Move and resize it to cover the target area.
6. Select **Save**.

## Snap a window

1. Hold Shift while you drag an application window over a zone.
2. Release the window when the zone is highlighted.

The window moves and resizes to fill the zone.
Drag a snapped window out of the zone to restore its previous size.

## Arrange windows by rule

Set the zone's application, window class, or title match in the Inspector.
Select **Arrange windows** from the tray menu to position matching windows.

A non-elevated Widgetsack process cannot move an elevated application window.
Some applications also restrict their window size or do not report standard drag events.
See [Window zone implementation](dev/window-zones.md) for native behavior and verification limits.
