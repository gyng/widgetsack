// Pure planning for on-demand auto-arrange ("position windows into the space if found", MVP3): given
// the landing zones (each carrying an optional match rule) and the running windows, decide which
// window snaps into which zone. No Tauri/React — the adapter (DragSnapLayer) gathers the zones from
// the zone widgets + their monitor geometry and performs the snapWindow calls. Zone rects here are
// PHYSICAL px. Reuses the tested matchWindowToZone.

import type { Rect } from './layout';
import type { Zone } from './zones';
import type { WindowDescriptor, ZoneRule } from './windowMatch';
import { matchWindowToZone } from './windowMatch';

/** The zones that carry a non-empty match rule, as `ZoneRule`s for `matchWindowToZone`. A zone whose
 * match has no exe/className/title is skipped (it would match nothing anyway). */
export function zoneRules(zones: Zone[]): ZoneRule[] {
	return zones
		.filter((z) => z.match && (z.match.exe || z.match.className || z.match.title))
		.map((z) => ({ zoneId: z.id, ...z.match }));
}

export type SnapPlan = { hwnd: number; zoneId: string; rect: Rect };

/**
 * The windows to snap and where: each running window is matched against the zones' rules and assigned
 * to its best matching zone, **one window per zone**. A zone, once claimed by a window, is removed from
 * the candidate set — so several windows of the same app (e.g. three File Explorer windows) spread
 * across that app's matching zones, one each, instead of stacking on top of each other in a single
 * zone. A window whose every matching zone is already taken is left unplaced (we never pile windows up
 * or move one blindly). Windows are processed in the given order (the enumeration's top-of-z-order
 * first), so the front window claims the highest-ranked zone. Pure — returns the plan; the caller
 * snaps. Returns [] when no zone has a rule (so an un-ruled zone set never moves anything).
 */
export function planArrangement(zones: Zone[], windows: WindowDescriptor[]): SnapPlan[] {
	const rules = zoneRules(zones);
	if (rules.length === 0) return [];
	const filled = new Set<string>();
	const plans: SnapPlan[] = [];
	for (const w of windows) {
		// Only zones not yet claimed by an earlier window are candidates for this one.
		const m = matchWindowToZone(
			w,
			rules.filter((rule) => !filled.has(rule.zoneId))
		);
		if (!m) continue;
		const zone = zones.find((z) => z.id === m.zoneId);
		/* v8 ignore next -- matchWindowToZone can only return an id from the supplied zone-derived rules. */
		if (!zone) continue;
		plans.push({ hwnd: w.hwnd, zoneId: zone.id, rect: zone.rect });
		filled.add(zone.id);
	}
	return plans;
}
