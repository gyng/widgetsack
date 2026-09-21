// Pure DOM-target classification for stage presses (no React, no Tauri). The studio stage is
// covered edge-to-edge by the flow frame + the root FlowNode div, so "is this press on empty
// canvas?" can't be answered by checking the target's OWN class (only `.world`/`.canvas` would
// match, and those are never the top element inside the monitor) — it has to walk up: on the stage
// (`.canvas`) and NOT inside anything that owns its own presses (widgets, splitters, grid cells,
// container tags, the docked panels). Unit-tested in stageHit.test.ts.

/** Docked studio chrome: a press/drop/context-menu inside any of these belongs to that panel. */
export const PANEL_SELECTOR =
	'.outline, .inspector, .studio-bar, .powerbar, .theme-editor, .ctx, .nav-rail, .rail-panel, .designer-list, .designer-empty, .studio-menu, .layout-banner';

/** Stage items that own their own pointer presses (never an empty-canvas press). */
export const STAGE_ITEM_SELECTOR = '.widget, .group-frame, .splitter, .grid-cell, .ctag, .marquee';

/**
 * True when a press landed on EMPTY canvas — inside the stage but not on a widget, a splitter, a
 * grid cell, a container tag, or a docked panel — so the studio may start a marquee (or a
 * margin pan) from it. A null / detached target is never on-canvas.
 */
export function isEmptyStagePress(target: EventTarget | null): boolean {
	const el = target instanceof Element ? target : null;
	if (!el || !el.closest('.canvas')) return false;
	return el.closest(`${STAGE_ITEM_SELECTOR}, ${PANEL_SELECTOR}`) === null;
}
