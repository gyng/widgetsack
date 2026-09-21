// Pure seam for the one-shot layout-key migration (legacy monitor keys → stable identity keys).
// No Tauri, no DOM: overlay.ts feeds it the current enumeration + the window-state hints and hands
// the result to migrateMonitorKeys (migration.ts).
//
// Two legacy key generations exist: the `availableMonitors()` enumeration index ('2') and the GDI
// device tag ('DISPLAY3'). Both are re-numbered by Windows: the index across reboots/hot-plugs, the
// tag whenever displays re-enumerate — on 2026-09-19 a primary switched to another HDMI input and
// back came up as DISPLAY3 instead of DISPLAY1, so a strip-monitor layout keyed 'DISPLAY3' rendered on
// the 4K. Mapping by today's names would bake exactly that mistake into the migration, so the saved
// overlay WINDOW SIZES break the tie: each `overlay-<legacy key>` window was fitted to its monitor's
// physical size, and a size that matches exactly one current non-primary monitor identifies it.

/** One current monitor as the migration sees it: enumeration `index`, stable `key` (monitorKey.ts —
 * the GDI tag itself when no stable id is known), bare GDI `tag`, and PHYSICAL rect (`x`/`y`
 * optional for callers that only know the size). */
export type MigrationMonitor = {
	index: number;
	key: string;
	tag: string;
	primary: boolean;
	w: number;
	h: number;
	x?: number;
	y?: number;
};

/** A window's last saved physical geometry (backend `window_state_hints`, from `.window-state.json`).
 * `x`/`y` are absent for entries older builds wrote without a position. */
export type WindowGeometryHint = {
	label: string;
	width: number;
	height: number;
	x?: number;
	y?: number;
};

const OVERLAY_LABEL = 'overlay-';

/** Geometry slack when matching a saved window to a monitor: a window that took Windows' DPI-hop
 * suggested rect is saved inflated by the 8 px resize frame on every side (2576x736 at 644,2152 for a
 * 2560x720 strip at 652,2160), and must still identify that monitor. */
const HINT_TOLERANCE_PX = 16;

const near = (a: number, b: number): boolean => Math.abs(a - b) <= HINT_TOLERANCE_PX;

/** The monitors a saved window geometry identifies: position + size when the hint carries a position
 * (the strongest evidence — two same-size monitors differ by where they are), else size alone. */
function hintMatches(
	hint: WindowGeometryHint,
	secondaries: readonly MigrationMonitor[]
): MigrationMonitor[] {
	const bySize = secondaries.filter((m) => near(m.w, hint.width) && near(m.h, hint.height));
	if (hint.x === undefined || hint.y === undefined) return bySize;
	const byRect = bySize.filter(
		(m) => m.x !== undefined && m.y !== undefined && near(m.x, hint.x!) && near(m.y, hint.y!)
	);
	// A positioned hint that matches nothing by position falls back to size: the monitor may have
	// been re-arranged since (the strip moved from y=1440 to y=2160 when the 4K returned).
	return byRect.length > 0 ? byRect : bySize;
}

/** Build the legacy-key → stable-key mapping for `migrateMonitorKeys`.
 *
 * 1. Every non-primary monitor maps its enumeration index and (when different from the key) its GDI
 *    tag to its stable key — right whenever the names have NOT been re-numbered since the save.
 * 2. Every `overlay-<legacy>` window whose saved geometry (position + size, or size alone for older
 *    entries; ±16 px for the DPI-hop frame inflation) matches exactly ONE current non-primary monitor
 *    maps `<legacy>` to that monitor instead — evidence beats today's name. A monitor claimed this way
 *    is claimed exclusively: its by-name entries from step 1 are dropped, so an unrelated layout that
 *    happens to carry today's name for it cannot be migrated onto the same key (first writer wins in
 *    migrateMonitorKeys, and the loser would silently vanish).
 * The primary is never a target ('default' is its key), and a legacy id that already IS a current
 * stable key is left alone. */
export function legacyKeyMapping(
	monitors: readonly MigrationMonitor[],
	hints: readonly WindowGeometryHint[]
): Record<string, string> {
	const secondaries = monitors.filter((m) => !m.primary);
	const stableKeys = new Set(monitors.map((m) => m.key));

	// Step 2 first, so we know which monitors are claimed by evidence before mapping by name.
	const claims = new Map<string, string[]>(); // stable key → legacy ids whose hint fits only it
	for (const hint of hints) {
		if (!hint.label.startsWith(OVERLAY_LABEL)) continue;
		const legacy = hint.label.slice(OVERLAY_LABEL.length);
		if (!legacy || stableKeys.has(legacy)) continue;
		const matches = hintMatches(hint, secondaries);
		if (matches.length !== 1) continue;
		const key = matches[0].key;
		claims.set(key, [...(claims.get(key) ?? []), legacy]);
	}

	const mapping: Record<string, string> = {};
	for (const m of secondaries) {
		const claimants = claims.get(m.key);
		if (claimants) {
			for (const legacy of claimants) mapping[legacy] = m.key; // evidence wins, exclusively
			continue;
		}
		mapping[String(m.index)] = m.key;
		if (m.tag && m.tag !== m.key) mapping[m.tag] = m.key;
	}
	return mapping;
}
