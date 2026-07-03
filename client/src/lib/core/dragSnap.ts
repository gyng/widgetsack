// Pure helpers for the live drag-to-zone overlay (MVP2). No Tauri/React — unit-tested directly; the
// DragSnapLayer wires Tauri events/polling around these. The "armed modifier" rule (locked decision):
// snapping engages only while Shift is held during a foreign-window drag.

import type { Rect } from './layout';
import type { Zone, ZoneMatch } from './zones';
import { hitTestZone } from './zones';
import type { LayoutNode, LayoutV2 } from './layoutTree';
import { isContainer, isGroup } from './layoutTree';

/** Live pointer state during a drag — cursor in PHYSICAL px + the arming modifier. Mirrors the Rust
 * `PointerState` (windowmgr.rs) 1:1. */
export type Pointer = { x: number; y: number; shift: boolean };

/** The zone the pointer is over WHEN ARMED (Shift held), else null. Not armed → null (no highlight,
 * no snap), so an ordinary drag is never hijacked. `zones` carry PHYSICAL rects. */
export function armedZone(zones: Zone[], p: Pointer): Zone | null {
	if (!p.shift) return null;
	const id = hitTestZone(zones, p.x, p.y);
	return id ? (zones.find((z) => z.id === id) ?? null) : null;
}

/** Build a {@link ZoneMatch} from a zone widget's config (matchExe/matchClass/matchTitle), or
 * undefined when none is set (a fieldless zone is a drag-only target). The config field names map onto
 * windowMatch's `ZoneRule` keys (exe/className/title), trimming blanks. Pure. */
export function matchOf(config: Record<string, unknown>): ZoneMatch | undefined {
	const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
	const exe = s(config.matchExe);
	const className = s(config.matchClass);
	const title = s(config.matchTitle);
	return exe || className || title ? { exe, className, title } : undefined;
}

/** The `zone` widgets DOCKED in monitor `key`'s flow tree (vs the floating layer), as id → match rule.
 * A docked zone's screen rect is NOT its `unit.rect` — the CSS flow positions it, so the overlay reads
 * the rect by MEASURING the rendered element; this carries only the match rule, keyed by the widget id
 * (which equals the element's `data-w`). Floating zones are handled separately (they keep their own
 * absolute rect). Zones nested inside a group are skipped (their id is namespaced in the DOM). Pure. */
export function collectDockedZoneMatches(
	layout: LayoutV2 | null,
	key: string
): Map<string, ZoneMatch | undefined> {
	const out = new Map<string, ZoneMatch | undefined>();
	const monitor = layout?.monitors[key];
	if (!monitor) return out;
	const walk = (node: LayoutNode): void => {
		if (isContainer(node)) {
			node.children.forEach(walk);
			return;
		}
		const unit = node.unit;
		if (isGroup(unit) || unit.type !== 'zone') return;
		out.set(unit.id, matchOf(unit.config));
	};
	walk(monitor.root);
	return out;
}

/** A zone widget's overlay-LOCAL logical-px rect (its `unit.rect`) expressed in PHYSICAL global px —
 * origin shifted by the monitor's physical position, size scaled by its DPI factor. This is what
 * `snap_window` / pointer hit-testing need (the inverse: snapped rects come back via SetWindowPos). */
export function localToPhysical(
	local: Rect,
	monitorPos: { x: number; y: number },
	scale: number
): Rect {
	return {
		x: monitorPos.x + local.x * scale,
		y: monitorPos.y + local.y * scale,
		w: local.w * scale,
		h: local.h * scale
	};
}
