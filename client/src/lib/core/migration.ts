// Version-aware parse + v1→v2 migration. v1 (flat `widgets[]` per monitor) migrates to
// v2 by dropping every widget into the `floating` layer (absolute rects unchanged) under
// an empty flow root — so existing/demo layouts render identically. v2 is validated
// structurally; individually malformed leaves are dropped (mirrors the v1 convention).
// Pure; ZERO Svelte/Tauri. Co-located vitest tests in migration.test.ts.
//
// Lives alongside ./layout.ts (v1) and ./layoutTree.ts (v2). The v1 `parseLayout` in
// layout.ts is left intact for v1-only callers; `parseLayoutAny` is the new
// version-aware front door the Canvas uses — it always normalises to v2.

import {
	type Layout as LayoutV1,
	type WidgetInstance,
	parseLayout as parseLayoutV1
} from './layout';
import {
	type Align,
	type Container,
	type Group,
	type Justify,
	type LayoutNode,
	type LayoutV2,
	type Leaf,
	type Length,
	type MonitorLayout,
	type Pad,
	emptyRoot
} from './layoutTree';
import { parseBackgroundSpec } from './background';
import { parseCondition } from './condition';

export type AnyLayout = LayoutV1 | LayoutV2;

// ---- public: version-aware entry -----------------------------------------

/**
 * Parse raw JSON into a v2 `LayoutV2` regardless of stored version (so callers deal
 * with one shape). v1 (or a missing/undefined version with `widgets[]`) is validated by
 * the existing v1 `parseLayout` then migrated; v2 is validated directly. Returns null
 * only on unrecoverable structural failure (the caller falls back to a default).
 */
export function parseLayoutAny(raw: unknown): LayoutV2 | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const obj = raw as Record<string, unknown>;
	const version = obj.version;

	if (version === 2) return parseLayoutV2(obj);
	if (version !== undefined && version !== 1) return null; // unknown / non-numeric version

	// Treat v1, or a legacy file with no version but a widgets[] shape, as v1.
	const v1raw = version === undefined ? { version: 1, ...obj } : raw;
	const v1 = parseLayoutV1(v1raw);
	if (v1 === null) return null;
	return migrateV1(v1);
}

// ---- v1 → v2 migration (no data moves) -----------------------------------

/** Wrap one v1 widget as a floating leaf (absolute rect preserved verbatim). */
function floatingLeafOf(w: WidgetInstance): Leaf {
	return { id: w.id, unit: w };
}

/**
 * Migrate a validated v1 Layout to v2: every widget becomes a floating leaf; root empty.
 * Widgets whose `rect` is not a full numeric rect are dropped (v1's `isWidgetInstance`
 * only checks that `rect` is an object, so a malformed `rect:{}` could otherwise reach
 * the solver as a Rect with undefined coords).
 */
export function migrateV1(v1: LayoutV1): LayoutV2 {
	const monitors: Record<string, MonitorLayout> = {};
	for (const [id, mon] of Object.entries(v1.monitors)) {
		const floating = mon.widgets.filter((w) => isRect(w.rect)).map(floatingLeafOf);
		monitors[id] = { root: emptyRoot(), floating };
	}
	return { version: 2, monitors };
}

// ---- monitor-key migration (index → stable device key) --------------------

/**
 * Remap legacy NUMERIC monitor keys (the old `availableMonitors()` enumeration index — unstable
 * across reboots/hot-plugs, the "layout drawn on the wrong monitor" bug) to stable device keys
 * ('DISPLAY3' …), using `mapping` (old index key → device key) gathered by the adapter from the
 * CURRENT enumeration. Positionally correct at migration time, stable ever after. 'default' (the
 * primary) and already-migrated device keys pass through; a numeric key with no current monitor
 * (unplugged) is kept as-is so its layout isn't orphaned silently. Returns null when nothing
 * needed remapping (caller skips the save). Pure, and generic over the monitor VALUE so the
 * adapter can remap the raw on-disk JSON record without round-tripping it through the parser
 * (which would strip fields the structural whitelist doesn't know).
 */
export function migrateMonitorKeys<T>(
	monitors: Record<string, T>,
	mapping: Record<string, string>
): Record<string, T> | null {
	let changed = false;
	const out: Record<string, T> = {};
	for (const [key, mon] of Object.entries(monitors)) {
		const isLegacyIndex = key !== 'default' && /^\d+$/.test(key);
		const next = isLegacyIndex ? mapping[key] : undefined;
		// Don't clobber an existing (already-migrated) monitor entry with a remapped legacy one.
		if (next && next !== key && !(next in monitors)) {
			out[next] = mon;
			changed = true;
		} else {
			out[key] = mon;
		}
	}
	return changed ? out : null;
}

// ---- v2 structural validation --------------------------------------------

function parseLayoutV2(obj: Record<string, unknown>): LayoutV2 | null {
	if (typeof obj.monitors !== 'object' || obj.monitors === null || Array.isArray(obj.monitors)) {
		return null;
	}
	const monitors: Record<string, MonitorLayout> = {};
	for (const [id, mon] of Object.entries(obj.monitors as Record<string, unknown>)) {
		const parsed = parseMonitor(mon);
		if (parsed === null) return null; // structural failure on a monitor → whole layout null
		monitors[id] = parsed;
	}
	return { version: 2, monitors };
}

function parseMonitor(raw: unknown): MonitorLayout | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const o = raw as Record<string, unknown>;

	const root = parseContainer(o.root);
	if (root === null) return null;

	const floatingRaw = o.floating;
	if (floatingRaw !== undefined && !Array.isArray(floatingRaw)) return null;
	const floating: Leaf[] = Array.isArray(floatingRaw)
		? floatingRaw.map(parseLeaf).filter((l): l is Leaf => l !== null)
		: [];

	// The per-monitor wallpaper layer (optional). A malformed background is dropped (→ undefined),
	// never fatal to the monitor.
	const background = parseBackgroundSpec(o.background);

	// Per-monitor theme override (optional). A bare string is kept verbatim ('' = explicit default,
	// distinct from absent = inherit the top-level theme); any non-string is dropped to undefined.
	const theme = typeof o.theme === 'string' ? (o.theme as string) : undefined;

	return {
		root,
		floating,
		...(background ? { background } : {}),
		...(theme !== undefined ? { theme } : {})
	};
}

// Tolerate a missing/non-object root by substituting an empty root; reject a present
// root with a bad `kind` (a structural authoring error) by failing the monitor.
function parseContainer(raw: unknown): Container | null {
	if (typeof raw !== 'object' || raw === null) return emptyRoot();
	const o = raw as Record<string, unknown>;
	const kind = o.kind;
	if (kind !== 'row' && kind !== 'col' && kind !== 'grid') return null;
	if (typeof o.id !== 'string') return null;

	const childrenRaw = o.children;
	const children: LayoutNode[] = Array.isArray(childrenRaw)
		? childrenRaw.map(parseNode).filter((n): n is LayoutNode => n !== null)
		: [];

	const c: Container = { id: o.id, kind, children };
	if (isLength(o.basis)) c.basis = o.basis as Length;
	if (typeof o.cols === 'number') c.cols = o.cols;
	if (typeof o.rows === 'number') c.rows = o.rows;
	if (typeof o.gap === 'number') c.gap = o.gap;
	if (isPad(o.pad)) c.pad = o.pad as Pad;
	if (isPad(o.margin)) c.margin = o.margin as Pad;
	if (isAlign(o.align)) c.align = o.align as Align;
	if (isJustify(o.justify)) c.justify = o.justify as Justify;
	if (isRect(o.bounds)) c.bounds = o.bounds as Container['bounds'];
	if (typeof o.overlap === 'boolean') c.overlap = o.overlap;
	// Grid cell sizing + per-track weights — these MUST be whitelisted or a saved grid silently loses
	// its non-uniform sizing on reload (the whitelist is the persistence contract; see parseLeaf).
	if (typeof o.cellW === 'number') c.cellW = o.cellW;
	if (typeof o.cellH === 'number') c.cellH = o.cellH;
	if (typeof o.aspect === 'number') c.aspect = o.aspect;
	if (isNumberArray(o.colFr)) c.colFr = o.colFr;
	if (isNumberArray(o.rowFr)) c.rowFr = o.rowFr;
	const condition = parseCondition(o.condition);
	if (condition) c.condition = condition;
	return c;
}

/** A finite-number array (grid track weights colFr/rowFr). */
function isNumberArray(v: unknown): v is number[] {
	return Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/**
 * Parse ONE layout node (container or leaf) through the same structural whitelist the v2
 * layout file goes through — for callers validating a node-shaped JSON outside a full layout
 * (a plugin package's template tree, core/pluginPackage.ts). Malformed children inside a
 * container are dropped (the v2 convention); a malformed root returns null. Never throws.
 */
export function parseLayoutNode(raw: unknown): LayoutNode | null {
	return parseNode(raw);
}

function parseNode(raw: unknown): LayoutNode | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const o = raw as Record<string, unknown>;
	if (o.kind === 'row' || o.kind === 'col' || o.kind === 'grid') return parseContainer(o);
	if ('unit' in o) return parseLeaf(o);
	return null;
}

function parseLeaf(raw: unknown): Leaf | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const o = raw as Record<string, unknown>;
	const unit = o.unit;
	if (!isUnit(unit)) return null;
	const id = typeof o.id === 'string' ? o.id : (unit as { id: string }).id;
	const lf: Leaf = { id, unit: unit as WidgetInstance | Group };
	if (isLength(o.basis)) lf.basis = o.basis as Length;
	// Per-side box + placement persist with the leaf (the whitelist must list every kept field, or it
	// silently drops on reload). `isPad` covers both number and {t,r,b,l} for margin/pad.
	if (isPad(o.margin)) lf.margin = o.margin as Pad;
	if (isPad(o.pad)) lf.pad = o.pad as Pad;
	if (isHAlign(o.halign)) lf.halign = o.halign as Leaf['halign'];
	if (isVAlign(o.valign)) lf.valign = o.valign as Leaf['valign'];
	return lf;
}

// A unit is either a primitive WidgetInstance or a Group. A group needs a `def` id OR a
// non-null inline `child` (a `child: null` group has nothing to render).
function isUnit(u: unknown): boolean {
	if (typeof u !== 'object' || u === null) return false;
	const o = u as Record<string, unknown>;
	if (o.kind === 'group') {
		return (
			typeof o.id === 'string' &&
			(typeof o.def === 'string' || (o.child !== undefined && o.child !== null))
		);
	}
	return (
		typeof o.id === 'string' &&
		typeof o.type === 'string' &&
		isRect(o.rect) &&
		typeof o.config === 'object' &&
		o.config !== null
	);
}

// ---- small validators ----------------------------------------------------

function isRect(r: unknown): boolean {
	if (typeof r !== 'object' || r === null) return false;
	const o = r as Record<string, unknown>;
	return (
		typeof o.x === 'number' &&
		typeof o.y === 'number' &&
		typeof o.w === 'number' &&
		typeof o.h === 'number'
	);
}

function isPad(p: unknown): boolean {
	if (typeof p === 'number') return true;
	if (typeof p !== 'object' || p === null) return false;
	const o = p as Record<string, unknown>;
	return ['t', 'r', 'b', 'l'].every((k) => typeof o[k] === 'number');
}

function isAlign(a: unknown): boolean {
	return a === 'start' || a === 'center' || a === 'end' || a === 'stretch';
}

function isHAlign(a: unknown): boolean {
	return a === 'left' || a === 'right' || a === 'center' || a === 'fill';
}

function isVAlign(a: unknown): boolean {
	return a === 'top' || a === 'middle' || a === 'bottom' || a === 'fill';
}

function isJustify(j: unknown): boolean {
	return j === 'start' || j === 'center' || j === 'end' || j === 'between' || j === 'around';
}

function isLength(b: unknown): boolean {
	// Length = number | 'auto' | 'content' | { fr }. Omitting 'content' here silently DROPPED a hug
	// (content) basis on every load (parseLeaf / parseContainer), so a hugged widget/group looked
	// right in the studio (in-memory) but clipped on the overlay (re-parsed) — the Network "hug
	// clips" bug.
	if (b === 'auto' || b === 'content' || typeof b === 'number') return true;
	return typeof b === 'object' && b !== null && typeof (b as { fr?: unknown }).fr === 'number';
}
