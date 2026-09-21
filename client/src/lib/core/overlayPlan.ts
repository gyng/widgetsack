// Pure seam for reconcileOverlays (overlay.ts): which secondary overlay windows to open and which to
// close, given the current monitors, the layout's populated keys, and the windows that exist. The
// invariant is simple — exactly one `overlay-<key>` per CONNECTED, NON-PRIMARY, POPULATED monitor,
// and nothing else — so the plan is a set difference, not a per-monitor walk. A per-monitor walk
// could only close windows for monitors it could still see, which left overlays behind whenever a
// monitor vanished (HDMI switched away — Windows relocated the orphan onto another screen) or became
// the primary (`main` covers it; its overlay stacked on top). No Tauri, no DOM; tested directly.

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
	const close = input.existingLabels.filter(
		(label) => label.startsWith(OVERLAY_LABEL_PREFIX) && !wanted.has(label)
	);
	return { create, close };
}
