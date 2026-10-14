// Pure seam for reconcileOverlays (overlay.ts): which secondary overlay windows to open and which to
// close, given the current monitors, the layout's populated keys, and the windows that exist. The
// invariant is simple — exactly one `overlay-<key>` per CONNECTED, NON-PRIMARY, POPULATED monitor,
// and nothing else — so the plan is a set difference, not a per-monitor walk. A per-monitor walk
// could only close windows for monitors it could still see, which left overlays behind whenever a
// monitor vanished (HDMI switched away — Windows relocated the orphan onto another screen) or became
// the primary (`main` covers it; its overlay stacked on top). No Tauri, no DOM; tested directly.

import { monitorHasWidgets, type MonitorLayout } from './layoutTree';

/** A connected monitor as the plan sees it: its stable layout key and whether it is the primary. */
export type PlanMonitor = { key: string; primary: boolean };

export const OVERLAY_LABEL_PREFIX = 'overlay-';

export type OverlayPlan = {
	/** Keys of monitors that need an `overlay-<key>` window created. */
	create: string[];
	/** Labels of `overlay-*` windows to close (not wanted by the invariant above). */
	close: string[];
};

export function planOverlays(input: {
	monitors: readonly PlanMonitor[];
	populated: ReadonlySet<string>;
	/** Keys whose saved record could not be parsed: whether they hold widgets is unknown, so an
	 * existing window for one is kept while its monitor is connected (never created). */
	unknown?: ReadonlySet<string>;
	existingLabels: readonly string[];
}): OverlayPlan {
	const wanted = new Set<string>();
	for (const m of input.monitors) {
		if (!m.primary && input.populated.has(m.key)) wanted.add(OVERLAY_LABEL_PREFIX + m.key);
	}
	const existing = new Set(input.existingLabels);
	const create: string[] = [];
	for (const label of wanted) {
		if (!existing.has(label)) create.push(label.slice(OVERLAY_LABEL_PREFIX.length));
	}
	const connected = new Set(input.monitors.filter((m) => !m.primary).map((m) => m.key));
	const close = input.existingLabels.filter((label) => {
		if (!label.startsWith(OVERLAY_LABEL_PREFIX) || wanted.has(label)) return false;
		const key = label.slice(OVERLAY_LABEL_PREFIX.length);
		return !(input.unknown?.has(key) && connected.has(key));
	});
	return { create, close };
}

/** Which saved monitor keys hold widgets (`populated`), and which raw keys were present in the file
 * but dropped by the parser (`unknown` — an unknown container kind after a downgrade, a hand edit).
 * A dropped record must not freeze reconciliation for every other monitor, nor be read as empty. */
export function monitorPresence(
	rawKeys: readonly string[],
	monitors: Readonly<Record<string, MonitorLayout>>
): { populated: Set<string>; unknown: Set<string> } {
	const populated = new Set<string>();
	const unknown = new Set<string>();
	for (const key of rawKeys) {
		if (!Object.hasOwn(monitors, key)) unknown.add(key);
		else if (monitorHasWidgets(monitors[key])) populated.add(key);
	}
	return { populated, unknown };
}

/** The monitor keys a key migration changed (renamed-away legacy keys and their new keys), so the
 * rewrite can go through save_layout's per-monitor merge instead of replacing the whole document. */
export function changedMonitorKeys(
	before: Readonly<Record<string, unknown>>,
	after: Readonly<Record<string, unknown>>
): string[] {
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...keys].filter(
		(k) => Object.hasOwn(before, k) !== Object.hasOwn(after, k) || before[k] !== after[k]
	);
}
