// Framework-agnostic v2 layout-tree types: the recursive model BOTH designers share
// (Phase 5 layout designer + Phase 6 widget designer). One node grammar, one pure
// solver (see ./solve.ts). ZERO Svelte/Tauri imports — reused verbatim by a future
// React port. Co-located vitest tests in layoutTree.test.ts.
//
// `Rect`, `WidgetInstance`, and the v1 `Layout` live in ./layout.ts (the single source
// of truth); this file re-exports the v1 names v2 consumers need and owns the v2
// grammar + small constructors. When a struct here crosses the Tauri bridge, keep the
// Rust side in sync (see AGENTS.md §5).

import type { Rect, WidgetInstance } from './layout';
import type { Tokens } from './tokens';
import type { Condition } from './condition';

export type { Rect, WidgetInstance } from './layout';

// A child's main-axis sizing inside a container.
//   number    → fixed px
//   'auto'    → intrinsic size (a primitive's rect.{w,h} / a group's size.{w,h})
//   'content' → like 'auto', but the leaf's rect is replaced by its MEASURED rendered size before
//               solving (the render layer feeds measurements in; the solver itself stays pure)
//   { fr: n } → share `n` of the leftover main-axis space after fixed/auto children
export type Length = number | 'auto' | 'content' | { fr: number };

export type Align = 'start' | 'center' | 'end' | 'stretch'; // cross axis
export type Justify = 'start' | 'center' | 'end' | 'between' | 'around'; // main axis
export type Pad = number | { t: number; r: number; b: number; l: number };

// A leaf's placement WITHIN the box the layout hands it, per screen axis (default 'fill' =
// span the box, the historical behaviour). 'fill' shrinks to nothing; the others size the
// leaf to its intrinsic extent on that axis and pin it left/center/right or top/middle/bottom.
// Only bites when the box is bigger than the leaf (a grown cell, a grid cell, an overlap stack).
export type AlignH = 'left' | 'center' | 'right' | 'fill';
export type AlignV = 'top' | 'middle' | 'bottom' | 'fill';

// The layout designer's panes/splits. hsplit = row, vsplit = col, multi-pane = grid.
export type Container = {
	id: string;
	kind: 'row' | 'col' | 'grid';
	basis?: Length; // this container's OWN main-axis sizing inside its parent (default 'auto')
	cols?: number; // grid only: 2 | 3 | 4 (ignored by row/col)
	rows?: number; // grid only: minimum rows (more are added as children overflow)
	gap?: number; // px between children (and between grid cells)
	pad?: Pad; // content-box inset
	margin?: Pad; // outer space around this container within its parent's flow
	align?: Align; // cross axis (row → vertical, col → horizontal)
	justify?: Justify; // main axis (ignored when an `fr` child consumes the leftover)
	bounds?: Rect; // explicit box; default = the contentRect passed to the solver
	overlap?: boolean; // stack children in the SAME box (overlapping/layered) instead of flowing
	// Grid CELL sizing (set on a cell to size its column/row): `cellW`/`cellH` fix that cell's
	// COLUMN width / ROW height (px) — other columns/rows split the remainder (non-uniform grid).
	// `aspect` (w/h) shapes the widget WITHIN its cell box (aspect-fit), not the grid.
	cellW?: number;
	cellH?: number;
	aspect?: number;
	// Grid only: per-TRACK weights for the FLEXIBLE columns/rows (those without a fixed cellW/cellH).
	// Index = track index; missing/≤0 entries default to 1. Undefined ⇒ uniform (the original even
	// split). Set by dragging a grid track splitter; cleared by "Distribute evenly". Frontend-owned.
	colFr?: number[];
	rowFr?: number[];
	// Optional runtime visibility condition (core/condition.ts): when present and unsatisfied, the
	// overlay keeps the container's space but hides its contents (the studio always shows it so it
	// stays editable). Absent ⇒ always shown. Any container can be made "conditional" this way.
	condition?: Condition;
	children: LayoutNode[];
};

// Built in the widget designer; ONE unit to the layout designer (a solver leaf).
// `def` references a reusable WidgetDef in the library; if absent/unresolved, the
// inline `child` is used. `size` is the group's own (intrinsic) box; `child` is in
// LOCAL coords (origin 0,0) and gets rebased to the group's absolute box when solved.
export type Group = {
	id: string;
	kind: 'group';
	name?: string;
	def?: string; // WidgetDef id; inline `child` used when absent/unresolved
	size: { w: number; h: number };
	child: LayoutNode;
	params?: Record<string, unknown>; // instance-side param overrides (Phase 6c)
	config?: Record<string, unknown>; // floating anchor lives here (config.x / config.y)
	css?: string;
	tokens?: Tokens; // per-group theme-token overrides (scoped to [data-group]); see WidgetInstance.tokens
};

// A placed unit: either a primitive widget or a group, with an optional main-axis basis.
export type Leaf = {
	id: string;
	unit: WidgetInstance | Group;
	basis?: Length; // default 'auto'
	halign?: AlignH; // horizontal placement within its solved box (default 'fill')
	valign?: AlignV; // vertical placement within its solved box (default 'fill')
	margin?: Pad; // outer space around the slot within its parent's flow (per-side)
	pad?: Pad; // inner inset between the slot edge and the widget (per-side)
};

export type LayoutNode = Container | Leaf;

// A full-monitor "wallpaper" effect rendered BEHIND every widget. Shown only when the overlay sits
// below windows / on the desktop (the studio always previews it) — in normal top-overlay mode a
// full-bleed background would cover the user's apps, so it's suppressed there. `kind` picks the
// source: 'color' (a CSS colour in `src`), 'image'/'video' (a file in the app-config `wallpapers/`
// folder, `src` = bare filename), or 'web' (a URL in `src`, embedded in a sandboxed iframe).
export type BackgroundKind = 'color' | 'image' | 'video' | 'web';
export type BackgroundFit = 'cover' | 'contain' | 'fill' | 'center' | 'tile';

export type BackgroundSpec = {
	kind: BackgroundKind;
	src?: string; // colour string | wallpapers/ filename | URL — per kind
	fit?: BackgroundFit; // image/video sizing (default 'cover')
	opacity?: number; // 0..1 of the media itself (default 1)
	dim?: number; // 0..1 dark scrim OVER the media to keep widgets legible (default 0)
	mute?: boolean; // video: start muted (default true — autoplay needs it)
	loop?: boolean; // video: loop (default true)
};

// Per monitor: the in-flow tree + an escape-the-grid floating layer (absolute coords) + an optional
// full-monitor background effect behind both.
export type MonitorLayout = {
	root: Container; // solved against the monitor work area (or root.bounds)
	floating: Leaf[]; // each placed by its own absolute rect (or group anchor)
	background?: BackgroundSpec; // the wallpaper layer (behind all widgets); undefined = transparent
	// Per-monitor theme override (a theme selection string, same vocabulary as the top-level `theme`:
	// '' = default tokens, `builtin:<id>`, or a user-theme filename). undefined = inherit the layout's
	// top-level `theme`. Lets each monitor carry its own look; the overlay resolves it on load.
	theme?: string;
};

export type LayoutV2 = {
	version: 2;
	monitors: Record<string, MonitorLayout>;
};

// Reusable library entry (Phase 6). Instantiate one def many times, rebinding params.
/** One value a select param can take (rendered as a dropdown option). */
export type ParamChoice = { value: string; label: string };
export type ParamSpec = {
	/** Shared content keeps iframe sandboxing after parameter overrides. */
	imported?: true;
	key: string; // e.g. 'core'
	label?: string;
	default?: unknown;
	target?: string; // dotted path into the cloned child, e.g. 'unit.sensor'
	targets?: string[]; // several paths driven by ONE value (e.g. a locale shared by two clocks)
	choices?: ParamChoice[]; // present → the param is a SELECT; values are validated against it
};

export type WidgetDef = {
	id: string;
	name: string;
	size: { w: number; h: number };
	child: LayoutNode;
	params?: ParamSpec[];
	css?: string; // restyles every instance of this def (scoped to [data-def], Phase 7)
};

export type Library = { version: number; defs: WidgetDef[] };

export const LAYOUT_VERSION_V2 = 2;

// ---- type guards (used by the solver + parse/migrate) ----

export function isContainer(node: LayoutNode): node is Container {
	const k = (node as Container).kind;
	return k === 'row' || k === 'col' || k === 'grid';
}

export function isLeaf(node: LayoutNode): node is Leaf {
	return (node as Leaf).unit !== undefined;
}

/** Whether a monitor's layout holds any actual widget (a leaf) — in the floating layer or
 * anywhere in the flow tree. Empty containers (panes/cells with no widget) don't count. Used to
 * skip spawning an overlay on a monitor that would render nothing. */
export function monitorHasWidgets(mon: MonitorLayout): boolean {
	if (mon.floating.length > 0) return true;
	const anyLeaf = (n: LayoutNode): boolean =>
		isLeaf(n) || (isContainer(n) && n.children.some(anyLeaf));
	return anyLeaf(mon.root);
}

export function isGroup(unit: WidgetInstance | Group): unit is Group {
	return (unit as Group).kind === 'group';
}

// ---- small constructors (keep call sites and tests terse, like createWidget) ----

/** An empty in-flow root: a column with no children (the v2 migration target). Stretches
 * its children to full width by default (like flexbox's own `align-items: stretch`), so a
 * pane added to the root fills the available width rather than collapsing to 0. */
// Editor-facing spacing defaults. The canvas spacing scale is 2 / 4 / 6 / 8 / 16
// (hairline / tight / default gap / section / screen edge — the demo seed's outer anchors).
// Applied at CREATION time only (new containers, fresh monitors); the solver keeps `?? 0`
// fallbacks, so layouts saved before these defaults existed render exactly as they did.
export const NEW_CONTAINER_GAP = 6;
export const ROOT_PAD = 16;

export function emptyRoot(): Container {
	// `pad` keeps docked widgets off the literal screen edge / taskbar line out of the box.
	return { id: 'root', kind: 'col', children: [], align: 'stretch', pad: ROOT_PAD };
}

export function emptyMonitorLayout(): MonitorLayout {
	return { root: emptyRoot(), floating: [] };
}

export function container(
	id: string,
	kind: Container['kind'],
	children: LayoutNode[],
	opts: Partial<Omit<Container, 'id' | 'kind' | 'children'>> = {}
): Container {
	return { id, kind, children, ...opts };
}

/** Wrap a primitive instance or a group as a leaf (id taken from the unit). */
export function leaf(unit: WidgetInstance | Group, basis?: Length): Leaf {
	return basis === undefined ? { id: unit.id, unit } : { id: unit.id, unit, basis };
}

export function group(
	id: string,
	size: { w: number; h: number },
	child: LayoutNode,
	opts: Partial<Omit<Group, 'id' | 'kind' | 'size' | 'child'>> = {}
): Group {
	return { id, kind: 'group', size, child, ...opts };
}

/** Normalize `pad` (number | object | undefined) into explicit per-side insets. */
export function resolvePad(pad: Pad | undefined): { t: number; r: number; b: number; l: number } {
	if (pad === undefined) return { t: 0, r: 0, b: 0, l: 0 };
	if (typeof pad === 'number') return { t: pad, r: pad, b: pad, l: pad };
	return pad;
}
