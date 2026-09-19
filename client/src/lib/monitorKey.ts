// Pure monitor-key seam, kept out of overlay.ts (the Tauri adapter) so it's unit-testable without
// a window — same split as monitorLabel.ts. The stable layout key is what layouts, overlay window
// labels (`overlay-<key>`), and the studio's monitor switcher all share.
//
// Identity, from most to least durable:
//   1. the STABLE key from the backend (display.rs: EDID hardware id + connector UID, e.g.
//      'CRXED00-UID184576') — the identity Windows itself keys per-monitor settings on;
//   2. the GDI device tag ('DISPLAY3'), when no stable key is known (non-Windows / plain browser /
//      an API miss). NOT durable: Windows re-numbers \\.\DISPLAYn whenever displays re-enumerate (a
//      primary switched to another input and back, sleep/wake) — on 2026-09-19 that moved a layout
//      keyed 'DISPLAY3' onto a different physical monitor;
//   3. a position-independent `m<i>` when the platform gives no device name at all (tests).
// The primary monitor's key stays 'default' (callers).

/** GDI device tag → stable identity key, as joined from `list_display_names` (`stable` field). */
export type StableIds = ReadonlyMap<string, string>;

/** The bare GDI device tag of a monitor name ('\\\\.\\DISPLAY3' → 'DISPLAY3'), '' when absent. */
export function gdiTag(name: string | null | undefined): string {
	return (name ?? '').replace(/^[\\.?]+/, '').trim();
}

/** A monitor's layout key: its stable identity when known, else its GDI device tag, else `m<i>`. */
export function monitorDeviceKey(
	name: string | null | undefined,
	index: number,
	stable?: StableIds
): string {
	const tag = gdiTag(name);
	if (!tag) return `m${index}`;
	return stable?.get(tag) || tag;
}

/** The monitor in `monitors` whose layout key is `key`, or null when none matches (e.g. the monitor
 * was unplugged). Resolves the stable key first, then — for a not-yet-migrated layout or an old
 * `overlay-DISPLAYn` window label — the legacy GDI tag. Index-aware so the `m<i>` fallback keys keep
 * matching on platforms with no device names. */
export function monitorByKey<T extends { name: string | null }>(
	monitors: T[],
	key: string,
	stable?: StableIds
): T | null {
	let i = monitors.findIndex((m, idx) => monitorDeviceKey(m.name, idx, stable) === key);
	if (i < 0 && stable) i = monitors.findIndex((m, idx) => monitorDeviceKey(m.name, idx) === key);
	return i >= 0 ? monitors[i] : null;
}
