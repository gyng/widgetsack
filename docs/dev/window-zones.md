# Window zone implementation

Zone widgets store target areas and match rules in the layout.
The overlay renders no normal widget content for them.
Studio renders editing outlines.
See [Window zones](../window-zones.md) for user instructions.

## Components

- [zones.ts](../../client/src/lib/core/zones.ts) defines interchange types and hit testing.
- [snapMath.ts](../../client/src/lib/core/snapMath.ts) computes frame compensation and target rectangles.
- [DragSnapLayer.tsx](../../client/src/lib/widgets/DragSnapLayer.tsx) gathers zones and renders drag highlights.
- [windowmgr.rs](../../widgetsack/src/windowmgr.rs) enumerates and moves native windows.

The drag layer uses both floating zones and measured docked zones.
Zone geometry is derived from widgets instead of a separate stored schema.
The overlay remains available on a monitor whose layout contains only zones.

## Native behavior

Windows event hooks detect move and size operations.
Holding Shift arms snapping during a drag.
Release snaps the target window to the highlighted zone.
Dragging out restores the prior size under the cursor.
Location-change handling supports some applications with nonstandard title bars.

Frame compensation accounts for invisible DWM borders.
The native operation waits for restoration to settle and clamps implausible frame margins.
Geometry helpers have pure tests in Rust and TypeScript.

`list_windows` and `snap_window` accept application windows through `require_app_window`.
Both Studio and overlays can call them.
Native work runs outside the main UI thread.
Hung targets are refused.
Elevated windows can reject operations from a non-elevated process.

## Verification

Automated tests cover geometry, hit testing, matching, and bridge contracts.
The ignored native smoke test moves a temporary Notepad window and checks its actual geometry.
Run it only in an interactive Windows session.

Live dragging still needs a manual check:

1. Create floating and docked zones on two monitors.
2. Hold Shift and drag a normal window through each zone.
3. Check the highlight and release position.
4. Drag out and check size restoration.
5. Test a custom-titlebar window and an elevated window.

Record failures separately from pure geometry results.
