// Pure layout UTILITIES that the CSS-rendered editor/overlay leans on (the recursive
// solver engine that once lived here is gone — native CSS now positions the flow tree).
// What remains, all pure (ZERO Svelte/Tauri, no DOM, no text measurement):
//   • collectors — collectRenderables / collectContainerRects / collectGridPlaceholders:
//     walk a monitor tree + a measured Map<id, Rect> and pair every rendered primitive,
//     container box, and empty grid cell with its rect (mirroring the old id namespacing).
//   • grid geometry — gridCellRects: every cell rect of a grid within a given box.
//   • group resolution — resolveGroup: a group instance → its concrete child subtree +
//     box, applying params onto a CLONED child (the def/inline tree is never mutated).
//   • intrinsic sizing — intrinsicSize: a node's natural {w,h}, used when turning a
//     subtree into a reusable WidgetDef.
// Co-located vitest tests in solve.test.ts.

import type { Rect, WidgetInstance } from './layout';
import {
	type Container,
	type Group,
	type LayoutNode,
	type Length,
	type Library,
	type MonitorLayout,
	type ParamSpec,
	type WidgetDef,
	isContainer,
	isGroup,
	isLeaf,
	resolvePad
} from './layoutTree';

export type Solved = Map<string, Rect>;
export type ResolvedGroup = { child: LayoutNode; size: { w: number; h: number } };

// A primitive widget ready to render: its solved rect + the (possibly group-cloned,
// param-applied) instance, plus how the overlay should treat it.
export type Renderable = {
	id: string; // namespaced solved id (unique across group instances)
	selectId: string; // what to select on click (the group's id for group descendants)
	instance: WidgetInstance;
	rect: Rect;
	movable: boolean; // true only for top-level floating primitives (free drag/resize)
	groupId?: string; // the (outermost) group leaf id, for group descendants — css hook
	defId?: string; // the (outermost) group's def id, for group descendants — css hook
};

/**
 * Pair every rendered primitive (flow tree + floating layer + group descendants) with
 * its measured rect, mirroring the namespaced ids the CSS render layer emits (a group
 * leaf prefixes its child ids with `${leaf.id}/`). Group descendants carry their group's
 * id as `selectId` (the group is the selectable unit) and are never movable. Pure —
 * `solved` is the measured Map<id, Rect>; this only walks + looks up.
 */
export function collectRenderables(
	monitor: MonitorLayout,
	solved: Solved,
	library?: Library
): Renderable[] {
	const out: Renderable[] = [];

	const walk = (
		node: LayoutNode,
		prefix: string,
		groupSel: string | null,
		defSel: string | null
	): void => {
		if (isContainer(node)) {
			for (const child of node.children) walk(child, prefix, groupSel, defSel);
			return;
		}
		const id = prefix + node.id;
		if (isGroup(node.unit)) {
			const { child } = resolveGroup(node.unit, library);
			walk(child, id + '/', groupSel ?? node.id, defSel ?? node.unit.def ?? null);
			return;
		}
		const rect = solved.get(id);
		if (rect) {
			out.push({
				id,
				selectId: groupSel ?? node.id,
				instance: node.unit,
				rect,
				movable: false,
				...(groupSel ? { groupId: groupSel } : {}),
				...(defSel ? { defId: defSel } : {})
			});
		}
	};

	walk(monitor.root, '', null, null);

	for (const lf of monitor.floating) {
		if (isGroup(lf.unit)) {
			const { child } = resolveGroup(lf.unit, library);
			walk(child, lf.id + '/', lf.id, lf.unit.def ?? null);
			continue;
		}
		const rect = solved.get(lf.id);
		if (rect) {
			out.push({ id: lf.id, selectId: lf.id, instance: lf.unit, rect, movable: true });
		}
	}

	return out;
}

// One container's solved box, for drawing pane boundaries in the editor.
export type ContainerBox = { id: string; rect: Rect; kind: Container['kind'] };

/**
 * Collect every flow-tree container's solved box (the root and its nested row/col/grid
 * panes), so the designer can outline the layout structure. Group internals (def subtrees)
 * are intentionally NOT descended into — only the monitor's own containers are surfaced.
 * Pure; `solved` is the measured Map<id, Rect> (which carries each container's own box).
 */
export function collectContainerRects(monitor: MonitorLayout, solved: Solved): ContainerBox[] {
	const out: ContainerBox[] = [];
	const walk = (node: LayoutNode): void => {
		if (!isContainer(node)) return;
		const rect = solved.get(node.id);
		if (rect) out.push({ id: node.id, rect, kind: node.kind });
		for (const child of node.children) walk(child);
	};
	walk(monitor.root);
	return out;
}

// Grid row count: the explicit `rows` (a minimum) grown to fit the children, at least 1 (so an
// EMPTY grid still shows one row of columns).
function gridRows(c: Container): number {
	const cols = Math.max(1, c.cols ?? 1);
	return Math.max(c.rows ?? 1, Math.ceil(c.children.length / cols), 1);
}

// A grid cell's fixed column width / row height (its `cellW`/`cellH`), or null when flexible.
function cellFixedW(node: LayoutNode): number | null {
	return isContainer(node) && typeof node.cellW === 'number' && node.cellW > 0 ? node.cellW : null;
}
function cellFixedH(node: LayoutNode): number | null {
	return isContainer(node) && typeof node.cellH === 'number' && node.cellH > 0 ? node.cellH : null;
}

// Column widths / row heights of a grid across the content axis. A track is FIXED to the max
// cellW/cellH among its cells; the remaining (flexible) tracks split the leftover equally. With no
// fixed cell the tracks are uniform — the original behaviour. Negative leftovers clamp to 0.
// A track's fr weight (for the flexible-track split), defaulting to 1 for missing/≤0 entries.
const trackWeight = (weights: number[] | undefined, t: number): number => {
	const w = weights?.[t];
	return typeof w === 'number' && w > 0 ? w : 1;
};

// Per-track fixed extent (px) or null when the track is flexible. A track is fixed iff some cell in
// it carries a cellW/cellH; the track takes the MAX such value among its cells. Shared by the track
// sizer and the splitter collector (which only offers boundaries between two FLEXIBLE tracks).
function gridFixedTracks(c: Container, count: number, horizontal: boolean): (number | null)[] {
	const cols = Math.max(1, c.cols ?? 1);
	const fixed: (number | null)[] = new Array(count).fill(null);
	c.children.forEach((child, i) => {
		const t = horizontal ? i % cols : Math.floor(i / cols);
		if (t >= count) return;
		const v = horizontal ? cellFixedW(child) : cellFixedH(child);
		if (v != null) fixed[t] = Math.max(fixed[t] ?? 0, v);
	});
	return fixed;
}

function gridTracks(c: Container, available: number, count: number, horizontal: boolean): number[] {
	const gap = clampGap(c.gap ?? 0, available, count);
	const fixed = gridFixedTracks(c, count, horizontal);
	const fixedSum = fixed.reduce((s: number, v) => s + (v ?? 0), 0);
	const weights = horizontal ? c.colFr : c.rowFr;
	// Flexible tracks split the leftover in proportion to their fr weight (uniform by default).
	let flexWeight = 0;
	for (let t = 0; t < count; t++) if (fixed[t] == null) flexWeight += trackWeight(weights, t);
	const leftover = Math.max(0, available - gap * (count - 1) - fixedSum);
	return fixed.map((v, t) =>
		v != null ? v : flexWeight > 0 ? (leftover * trackWeight(weights, t)) / flexWeight : 0
	);
}

function gridColWidths(c: Container, contentW: number): number[] {
	return gridTracks(c, contentW, Math.max(1, c.cols ?? 1), true);
}
function gridRowHeights(c: Container, contentH: number): number[] {
	return gridTracks(c, contentH, gridRows(c), false);
}

// Clamp a container's own gap to the space spanning `count` tracks/children on an axis, so the gap
// alone can never walk the trailing track/child past the box (the over-padded designer canvas case,
// where the available space collapses to ~0). Overflow from oversized children/cells is unaffected.
function clampGap(gap: number, available: number, count: number): number {
	return count > 1 ? Math.min(gap, available / (count - 1)) : gap;
}

// Prefix offsets of each track (col/row) start, given the track sizes + gap.
function trackOffsets(sizes: number[], gap: number, start: number): number[] {
	const offs: number[] = [];
	let cur = start;
	for (const s of sizes) {
		offs.push(cur);
		cur += s + gap;
	}
	return offs;
}

// Every cell rect of a grid container (cols × rows, row-major), with per-cell fixed widths/heights
// (non-uniform tracks). Exported for the designer's cell outlines and drop targeting.
export function gridCellRects(c: Container, box: Rect): Rect[] {
	const content = insetPad(box, c.pad);
	const cols = Math.max(1, c.cols ?? 1);
	const rows = gridRows(c);
	const gap = c.gap ?? 0;
	const colW = gridColWidths(c, content.w);
	const rowH = gridRowHeights(c, content.h);
	const colX = trackOffsets(colW, clampGap(gap, content.w, cols), content.x);
	const rowY = trackOffsets(rowH, clampGap(gap, content.h, rows), content.y);
	const cells: Rect[] = [];
	for (let i = 0; i < cols * rows; i++) {
		const col = i % cols;
		const row = Math.floor(i / cols);
		cells.push({ x: colX[col], y: rowY[row], w: colW[col], h: rowH[row] });
	}
	return cells;
}

/**
 * Empty grid cells across the flow tree (the trailing cells a grid has no child for), so the
 * designer can outline where the next widgets land — including showing the columns of a grid
 * that's still empty. Pure; needs each grid container's measured box in `solved`.
 */
export type GridPlaceholder = { gridId: string; index: number; rect: Rect };

export function collectGridPlaceholders(monitor: MonitorLayout, solved: Solved): GridPlaceholder[] {
	const out: GridPlaceholder[] = [];
	const walk = (node: LayoutNode): void => {
		if (!isContainer(node)) return;
		if (node.kind === 'grid') {
			const box = solved.get(node.id);
			if (box) {
				const cells = gridCellRects(node, box);
				for (let i = node.children.length; i < cells.length; i++)
					out.push({ gridId: node.id, index: i, rect: cells[i] });
			}
		}
		for (const child of node.children) walk(child);
	};
	walk(monitor.root);
	return out;
}

// --- splitters (interactive resize of row/col proportions) ----------------

const frOf = (n: LayoutNode): number | null => {
	const b = (n as { basis?: Length }).basis;
	return typeof b === 'object' && b !== null && 'fr' in b ? b.fr : null;
};

// A draggable boundary between two adjacent `fr` children of a row/col container. Only fr↔fr pairs
// resize (they share the proportional pool); fixed/content children are skipped. `mainA`/`mainB` are
// the children's CURRENT sizes along the container's main axis; `frA`/`frB` their current weights.
export type Splitter = {
	containerId: string;
	axis: 'row' | 'col';
	aId: string;
	bId: string;
	frA: number;
	frB: number;
	mainA: number;
	mainB: number;
	rect: Rect; // the draggable bar, in layout coords
	// When present, this boundary resizes two GRID TRACKS (columns or rows) via the grid's colFr/rowFr
	// weights, not two child basis weights. `a`/`b` are the track indices either side of the boundary.
	track?: { which: 'col' | 'row'; a: number; b: number };
};

const SPLIT_BAR = 8; // bar thickness / hit area (px)

// Draggable boundaries between adjacent FLEXIBLE grid tracks (columns → vertical bars, rows →
// horizontal bars), spanning the grid's full content extent. Resizing redistributes the two tracks'
// colFr/rowFr weights (kept-sum, like the row/col splitter) so the other tracks stay put. Boundaries
// touching a FIXED track (a cell with cellW/cellH) are skipped — those tracks aren't proportional.
function gridSplitters(node: Container, box: Rect): Splitter[] {
	const out: Splitter[] = [];
	const content = insetPad(box, node.pad);
	const cols = Math.max(1, node.cols ?? 1);
	const rows = gridRows(node);
	const gap = node.gap ?? 0;
	const colW = gridColWidths(node, content.w);
	const rowH = gridRowHeights(node, content.h);
	const colX = trackOffsets(colW, clampGap(gap, content.w, cols), content.x);
	const rowY = trackOffsets(rowH, clampGap(gap, content.h, rows), content.y);
	const colFixed = gridFixedTracks(node, cols, true);
	const rowFixed = gridFixedTracks(node, rows, false);
	for (let t = 0; t < cols - 1; t++) {
		if (colFixed[t] != null || colFixed[t + 1] != null) continue;
		const xMid = (colX[t] + colW[t] + colX[t + 1]) / 2;
		out.push({
			containerId: node.id,
			axis: 'row', // vertical bar (resizes horizontally)
			aId: `${node.id}#col${t}`,
			bId: `${node.id}#col${t + 1}`,
			frA: trackWeight(node.colFr, t),
			frB: trackWeight(node.colFr, t + 1),
			mainA: colW[t],
			mainB: colW[t + 1],
			rect: { x: xMid - SPLIT_BAR / 2, y: content.y, w: SPLIT_BAR, h: content.h },
			track: { which: 'col', a: t, b: t + 1 }
		});
	}
	for (let t = 0; t < rows - 1; t++) {
		if (rowFixed[t] != null || rowFixed[t + 1] != null) continue;
		const yMid = (rowY[t] + rowH[t] + rowY[t + 1]) / 2;
		out.push({
			containerId: node.id,
			axis: 'col', // horizontal bar (resizes vertically)
			aId: `${node.id}#row${t}`,
			bId: `${node.id}#row${t + 1}`,
			frA: trackWeight(node.rowFr, t),
			frB: trackWeight(node.rowFr, t + 1),
			mainA: rowH[t],
			mainB: rowH[t + 1],
			rect: { x: content.x, y: yMid - SPLIT_BAR / 2, w: content.w, h: SPLIT_BAR },
			track: { which: 'row', a: t, b: t + 1 }
		});
	}
	return out;
}

export function collectSplitters(monitor: MonitorLayout, solved: Solved): Splitter[] {
	const out: Splitter[] = [];
	const walk = (node: LayoutNode): void => {
		if (!isContainer(node)) return;
		if (node.kind === 'grid') {
			const box = solved.get(node.id);
			if (box) out.push(...gridSplitters(node, box));
		}
		if ((node.kind === 'row' || node.kind === 'col') && node.children.length >= 2) {
			const horiz = node.kind === 'row';
			for (let i = 0; i < node.children.length - 1; i++) {
				const a = node.children[i];
				const b = node.children[i + 1];
				const frA = frOf(a);
				const frB = frOf(b);
				if (frA === null || frB === null) continue; // only fr↔fr pairs share the proportional pool
				const ra = solved.get(a.id);
				const rb = solved.get(b.id);
				if (!ra || !rb) continue;
				const rect = horiz
					? { x: (ra.x + ra.w + rb.x) / 2 - SPLIT_BAR / 2, y: ra.y, w: SPLIT_BAR, h: ra.h }
					: { x: ra.x, y: (ra.y + ra.h + rb.y) / 2 - SPLIT_BAR / 2, w: ra.w, h: SPLIT_BAR };
				out.push({
					containerId: node.id,
					axis: node.kind,
					aId: a.id,
					bId: b.id,
					frA,
					frB,
					mainA: horiz ? ra.w : ra.h,
					mainB: horiz ? rb.w : rb.h,
					rect
				});
			}
		}
		for (const child of node.children) walk(child);
	};
	walk(monitor.root);
	return out;
}

// Fractions of the combined A+B span the boundary snaps to (and their mirrors).
const SPLIT_SNAPS = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4];

/**
 * New fr weights for a dragged splitter. Keeps the pair's COMBINED fr constant (so other siblings are
 * untouched) and only re-divides the ratio. `deltaMain` is the pointer travel along the main axis (in
 * layout px). The boundary snaps to a SPLIT_SNAPS fraction within `snapPx`, and each side keeps at
 * least `minPx`. Pure.
 */
export function resizeSplit(
	sizeA: number,
	sizeB: number,
	frA: number,
	frB: number,
	deltaMain: number,
	opts: { snapPx?: number; minPx?: number } = {}
): { frA: number; frB: number } {
	const snapPx = opts.snapPx ?? 14;
	const minPx = opts.minPx ?? 16;
	const total = sizeA + sizeB;
	const combinedFr = frA + frB;
	if (total <= 0 || combinedFr <= 0) return { frA, frB };
	let newA = Math.min(total - minPx, Math.max(minPx, sizeA + deltaMain));
	for (const s of SPLIT_SNAPS) {
		if (Math.abs(newA - s * total) <= snapPx) {
			newA = s * total;
			break;
		}
	}
	const fraction = newA / total;
	const a = Math.max(0.01, Number((fraction * combinedFr).toFixed(3)));
	const b = Math.max(0.01, Number(((1 - fraction) * combinedFr).toFixed(3)));
	return { frA: a, frB: b };
}

type Size = { w: number; h: number };

/**
 * Resolve a group instance to the concrete child subtree + box to solve inside. Looks
 * up `def` in the library (falling back to the group's inline `child`/`size` when the
 * def is missing/unresolved), then applies the instance's `params` as overrides onto a
 * CLONED child (the def/inline tree is never mutated). Pure.
 */
export function resolveGroup(grp: Group, library?: Library): ResolvedGroup {
	const def: WidgetDef | undefined =
		grp.def && library ? library.defs.find((d) => d.id === grp.def) : undefined;

	const baseChild: LayoutNode | undefined = def ? def.child : grp.child;
	const size: Size = def ? def.size : (grp.size ?? { w: 0, h: 0 });

	if (!baseChild) return { child: emptyContainer(grp.id + ':empty'), size };

	const child = cloneNode(baseChild);
	if (grp.params) applyParams(child, def?.params, grp.params);
	return { child, size };
}

/** A node's intrinsic box ({w,h}) — used to seed a new WidgetDef's `size` when a subtree
 * is turned into a reusable widget (Phase 6a). Pure. */
export function intrinsicSize(node: LayoutNode, library?: Library): { w: number; h: number } {
	return { w: intrinsicMain(node, true, library), h: intrinsicMain(node, false, library) };
}

// ---- sizing helpers ------------------------------------------------------

// Intrinsic main extent of a node (used for basis 'auto' and cross-axis clamping).
function intrinsicMain(
	node: LayoutNode,
	horizontal: boolean,
	library: Library | undefined
): number {
	if (isLeaf(node)) {
		const unit = node.unit;
		if (isGroup(unit)) {
			const { size } = resolveGroup(unit, library);
			return horizontal ? size.w : size.h;
		}
		return horizontal ? unit.rect.w : unit.rect.h;
	}
	return intrinsicContainer(node, horizontal, library);
}

// A nested container's intrinsic extent along `horizontal`: explicit bounds if set,
// else derived from children. row/col: sum of child extents (+ gaps) along the child
// main axis, max child extent along the cross axis. grid: cols × max-child-width
// (+ gaps) horizontally, rows × max-child-height (+ gaps) vertically — so a bounds-less
// grid (e.g. the 8-col/32 core-graph case) reports a real size instead of collapsing.
function intrinsicContainer(
	c: Container,
	horizontal: boolean,
	library: Library | undefined
): number {
	if (c.bounds) return horizontal ? c.bounds.w : c.bounds.h;
	const pad = resolvePad(c.pad);
	const padAlong = horizontal ? pad.l + pad.r : pad.t + pad.b;
	const n = c.children.length;
	if (n === 0) return padAlong;

	const gap = c.gap ?? 0;
	const extents = c.children.map((ch) => intrinsicMain(ch, horizontal, library));

	// Overlapping children share one box, so the container is only as big as its largest child.
	if (c.overlap) return padAlong + Math.max(...extents);

	if (c.kind === 'grid') {
		const cols = Math.max(1, c.cols ?? 1);
		const rows = gridRows(c);
		const count = horizontal ? cols : rows;
		// With per-cell fixed sizes, sum each track (its fixed size, else its largest child); with
		// none it's the uniform cols×max-child (the original formula) so existing grids are unchanged.
		const hasFixed = c.children.some(
			(ch) => (horizontal ? cellFixedW(ch) : cellFixedH(ch)) != null
		);
		if (hasFixed) {
			const tracks = new Array<number>(count).fill(0);
			c.children.forEach((child, i) => {
				const t = horizontal ? i % cols : Math.floor(i / cols);
				if (t >= count) return;
				const fixed = horizontal ? cellFixedW(child) : cellFixedH(child);
				tracks[t] = Math.max(tracks[t], fixed ?? extents[i]);
			});
			return padAlong + tracks.reduce((s, v) => s + v, 0) + gap * (count - 1);
		}
		return padAlong + Math.max(...extents) * count + gap * (count - 1);
	}

	const along = (c.kind === 'row') === horizontal; // is the queried axis the child main axis?
	if (along) return padAlong + sum(extents) + gap * (n - 1);
	return padAlong + Math.max(...extents);
}

// ---- pad ------------------------------------------------------------------

function insetPad(box: Rect, pad: Container['pad']): Rect {
	const p = resolvePad(pad);
	// Clamp the LEADING inset to the box so an oversized pad (e.g. a pad larger than the widget's own
	// size in the designer) collapses the content to zero AT the far edge instead of pushing its
	// origin — and therefore every child — outside the container's bounds. Width/height still floor
	// at 0, so the documented "pad larger than the box → zero-size content" behaviour is preserved.
	return {
		x: box.x + Math.min(p.l, box.w),
		y: box.y + Math.min(p.t, box.h),
		w: Math.max(0, box.w - p.l - p.r),
		h: Math.max(0, box.h - p.t - p.b)
	};
}

// ---- group params / clone (Phase 6c) -------------------------------------

/** Write `params` onto a (cloned) child tree following each spec's dotted path(s) — `targets`
 * (several nodes driven by one value), else `target`, else the default 'unit.config.<key>'.
 * Exported so the template system applies insert-time options through the SAME mechanism. */
export function applyParams(
	child: LayoutNode,
	specs: ParamSpec[] | undefined,
	params: Record<string, unknown>
): void {
	if (!specs) return;
	for (const spec of specs) {
		if (!(spec.key in params)) continue;
		const targets = spec.targets ?? [spec.target ?? 'unit.config.' + spec.key];
		for (const target of targets) {
			setPath(child as unknown as Record<string, unknown>, target, params[spec.key]);
		}
	}
}

// Fail-closed dotted-path setter: writes the final segment only if every intermediate
// already exists as an object. So a default target 'unit.config.<key>' resolves on a
// Leaf-rooted child (unit + config exist) but is a NO-OP on a container-rooted child
// (no `unit`) — never auto-vivifying a bogus `unit` object onto a container.
function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split('.');
	let cur: Record<string, unknown> = root;
	for (let i = 0; i < parts.length - 1; i++) {
		const next = cur[parts[i]];
		if (typeof next !== 'object' || next === null) return;
		cur = next as Record<string, unknown>;
	}
	cur[parts[parts.length - 1]] = value;
}

// ---- misc ----------------------------------------------------------------

function emptyContainer(id: string): Container {
	return { id, kind: 'col', children: [] };
}

// Structural deep clone — nodes are plain JSON-shaped data (no functions/cycles), so
// keeping resolveGroup free of aliasing between instances is a JSON round-trip.
function cloneNode<T extends LayoutNode>(node: T): T {
	return JSON.parse(JSON.stringify(node)) as T;
}

function sum(xs: number[]): number {
	let s = 0;
	for (const x of xs) s += x;
	return s;
}
