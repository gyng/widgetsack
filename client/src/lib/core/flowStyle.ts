// flowStyle.ts — map the layout grammar to NATIVE CSS, so the browser lays out the flow tree
// instead of the pure solver (solve.ts). This is the keystone of the CSS-layout pivot: the same
// row/col/grid + basis + align/justify grammar that the solver interpreted into rects is here
// interpreted into `display:flex`/`grid` + flex/grid item properties, and the browser does the
// rest. The render layer then reads back rects (ResizeObserver) for hit-testing + the editor.
//
// Two pure functions, framework-agnostic (plain camelCase style objects, no React/DOM), so they
// stay unit-testable WITHOUT a layout engine — co-located tests in flowStyle.test.ts assert the
// emitted CSS. `containerStyle` styles a node AS a flex/grid container (for its children);
// `itemStyle` styles it AS a child of its parent's flow (sizing + self-alignment).

import {
	isContainer,
	isGroup,
	isLeaf,
	resolvePad,
	type Align,
	type AlignH,
	type AlignV,
	type Container,
	type Justify,
	type LayoutNode,
	type Length,
	type Pad
} from './layoutTree';
import { getMeta } from './widget';

// A plain inline-style map (camelCase keys, React-applies verbatim). Kept framework-agnostic.
export type Style = Record<string, string | number>;

// Cross-axis align (align-items) — the container's `align`.
const ALIGN_ITEMS: Record<Align, string> = {
	start: 'flex-start',
	center: 'center',
	end: 'flex-end',
	stretch: 'stretch'
};
// Main-axis distribute (justify-content) — the container's `justify`.
const JUSTIFY_CONTENT: Record<Justify, string> = {
	start: 'flex-start',
	center: 'center',
	end: 'flex-end',
	between: 'space-between',
	around: 'space-around'
};
// Grid cell alignment (justify-items / align-items) — the grid's `align`, applied to every cell.
const GRID_ITEMS: Record<Align, string> = {
	start: 'start',
	center: 'center',
	end: 'end',
	stretch: 'stretch'
};

// A leaf's halign/valign → a self-alignment keyword. Flex `align-self` wants flex-* on the cross
// axis; grid justify-self/align-self want plain start/end. 'fill' = stretch on both.
const FLEX_SELF: Record<AlignH | AlignV, string> = {
	left: 'flex-start',
	right: 'flex-end',
	top: 'flex-start',
	bottom: 'flex-end',
	center: 'center',
	middle: 'center',
	fill: 'stretch'
};
const GRID_SELF: Record<AlignH | AlignV, string> = {
	left: 'start',
	right: 'end',
	top: 'start',
	bottom: 'end',
	center: 'center',
	middle: 'center',
	fill: 'stretch'
};
// A leaf's halign/valign exposed to its METER as CSS vars (--np-halign / --np-valign) — a flex
// place keyword the meter applies to its OWN content when that content is smaller than the box
// (e.g. the analog-clock dial), so it aligns per the leaf instead of always centering.
const HALIGN_PLACE: Record<AlignH, string> = {
	left: 'flex-start',
	center: 'center',
	right: 'flex-end',
	fill: 'stretch'
};
const VALIGN_PLACE: Record<AlignV, string> = {
	top: 'flex-start',
	middle: 'center',
	bottom: 'flex-end',
	fill: 'stretch'
};

function isFr(b: Length | undefined): b is { fr: number } {
	return typeof b === 'object' && b !== null && 'fr' in b;
}

// Per-track fixed sizes for a grid axis (mirrors the solver's gridTracks fixed array): a track is
// pinned to the max cellW (cols) / cellH (rows) among its cells; flexible tracks stay null. Returns
// null when no cell fixes a size on this axis → the caller emits uniform `repeat(n, 1fr)`.
function gridFixedTracks(
	c: Container,
	count: number,
	horizontal: boolean
): (number | null)[] | null {
	const cols = Math.max(1, c.cols ?? 1);
	const fixed: (number | null)[] = new Array(count).fill(null);
	let any = false;
	c.children.forEach((child, i) => {
		const track = horizontal ? i % cols : Math.floor(i / cols);
		if (track >= count) return;
		const v = isContainer(child) ? (horizontal ? child.cellW : child.cellH) : undefined;
		if (typeof v === 'number' && v > 0) {
			fixed[track] = Math.max(fixed[track] ?? 0, v);
			any = true;
		}
	});
	return any ? fixed : null;
}

// A grid track template: explicit `Npx`/`1fr` tracks when any cell is fixed (CSS splits the leftover
// among the 1fr tracks exactly like the solver), else uniform `repeat(count, 1fr)`.
function gridTemplate(c: Container, count: number, horizontal: boolean): string {
	const fixed = gridFixedTracks(c, count, horizontal);
	if (!fixed) return `repeat(${count}, 1fr)`;
	return fixed.map((v) => (v != null ? `${v}px` : '1fr')).join(' ');
}

/**
 * Style a node AS a flow CHILD of its parent (`parentKind`): how it sizes on the main axis (its
 * `basis`) plus, for a leaf, its own placement (`halign`/`valign`). Mirrors the solver's basis +
 * placeLeafInBox, expressed as flex/grid item properties:
 *   - basis {fr:n} → flex-grow:n, flex-basis:0 (proportional share of the leftover; min-*:0 so it
 *     can shrink past content like the solver's fr).
 *   - basis number → a fixed px flex-basis (no grow/shrink).
 *   - basis 'auto'/'content'/unset → content-sized (flex:0 0 auto).
 * Per-leaf alignment maps to align-self on the cross axis and auto-margins on the main axis (flex),
 * or justify-self/align-self in a grid cell (independent 2D).
 */
export function itemStyle(node: LayoutNode, parentKind: Container['kind']): Style {
	const s: Style = {};
	const basis = (node as { basis?: Length }).basis;
	if (isFr(basis)) {
		s.flexGrow = Math.max(0, basis.fr);
		s.flexShrink = 1;
		s.flexBasis = 0;
		s.minWidth = 0;
		s.minHeight = 0;
	} else if (typeof basis === 'number') {
		s.flexGrow = 0;
		s.flexShrink = 0;
		s.flexBasis = `${Math.max(0, basis)}px`;
	} else if (
		basis === 'content' &&
		isLeaf(node) &&
		!isGroup(node.unit) &&
		getMeta(node.unit.type)?.intrinsic
	) {
		// 'content' on an INTRINSIC (text) meter: shrink-wrap to the RENDERED content (the grammar's
		// definition of 'content'), so adjacent text leaves — e.g. a date "4" and month "JUNE" — each
		// fit their own text and sit tight instead of being pinned to a stale stored width. flex-basis
		// auto → max-content; shrink:1 + min:0 lets a cramped row shrink past content instead of
		// overflowing. FILL meters (no intrinsic size) deliberately skip this and keep their box below.
		s.flexGrow = 0;
		s.flexShrink = 1;
		s.flexBasis = 'auto';
		s.minWidth = 0;
		s.minHeight = 0;
	} else if (basis === 'content' && isLeaf(node) && !isGroup(node.unit)) {
		// 'content' on a FILL meter (gauge / sparkline / cpu / GPU panel / …, no intrinsic size):
		// keep its authored box as the DEFAULT extent (flex-basis), but FLOOR both axes at the
		// content's min-content so it's never squeezed below its own content and then clipped by the
		// slot's overflow:hidden — the cause of the GPU VRAM / network "hug clips" reports. The cross
		// axis (stretch) otherwise has no min-content floor. Meter fonts are FIXED (only AnalogClock is
		// container-query scaled), so min-content is stable: no measure→grow feedback. flex-shrink:0 +
		// the floor mean a hugged meter sits at max(authored box, its content).
		s.flexGrow = 0;
		s.flexShrink = 0;
		const rect = node.unit.rect;
		s.flexBasis = `${parentKind === 'row' ? rect.w : rect.h}px`;
		s.minWidth = 'min-content';
		s.minHeight = 'min-content';
	} else {
		// 'auto' / unset: a LEAF takes its STORED main extent (primitive rect / group size) as the
		// flex-basis, so a fill-meter (width/height:100%, no intrinsic size) keeps the authored box the
		// solver used to give it via intrinsicMain — otherwise flex:0 0 auto would collapse it toward 0.
		// A CONTAINER shrink-wraps its children (flex-basis:auto). The cross axis is filled by the
		// container's default align-items:stretch.
		s.flexGrow = 0;
		s.flexShrink = 0;
		const size = isLeaf(node) ? (isGroup(node.unit) ? node.unit.size : node.unit.rect) : null;
		s.flexBasis = size ? `${parentKind === 'row' ? size.w : size.h}px` : 'auto';
	}

	// Per-side OUTER margin (space around this node in its parent's flow). Set BEFORE the placement
	// block below so the halign/valign auto-margins still win on their own axis (center/right/bottom).
	const margin = (node as { margin?: Pad }).margin;
	if (margin !== undefined) {
		const m = resolvePad(margin);
		s.marginTop = m.t;
		s.marginRight = m.r;
		s.marginBottom = m.b;
		s.marginLeft = m.l;
	}
	// Per-side INNER padding insets the widget inside its slot (leaves only — containers pad via
	// containerStyle). The slot is border-box (FlowNode), so padding shrinks the content area.
	if (isLeaf(node) && node.pad !== undefined) {
		const p = resolvePad(node.pad);
		s.padding = `${p.t}px ${p.r}px ${p.b}px ${p.l}px`;
	}

	const ha = (node as { halign?: AlignH }).halign;
	const va = (node as { valign?: AlignV }).valign;
	// A FILL meter (no intrinsic size: gauge/sparkline/analogclock/…) must keep its CROSS axis stretched
	// — sizing it to content via align-self (flex-start/center/end from halign/valign) collapses it to 0
	// (width/height:100% with no definite cross extent). Its visual placement happens INSIDE the meter
	// via the --np-halign/--np-valign vars below. Intrinsic (text) leaves + containers still self-align.
	const fillLeaf = isLeaf(node) && !isGroup(node.unit) && !getMeta(node.unit.type)?.intrinsic;
	if (parentKind === 'grid') {
		if (ha && !fillLeaf) s.justifySelf = GRID_SELF[ha];
		if (va && !fillLeaf) s.alignSelf = GRID_SELF[va];
	} else if (parentKind === 'row') {
		// row: cross axis is vertical → valign = align-self; main axis horizontal → auto margins.
		if (va && !fillLeaf) s.alignSelf = FLEX_SELF[va];
		if (ha === 'center') {
			s.marginLeft = 'auto';
			s.marginRight = 'auto';
		} else if (ha === 'right') {
			s.marginLeft = 'auto';
		}
	} else {
		// col: cross axis is horizontal → halign = align-self; main axis vertical → auto margins.
		if (ha && !fillLeaf) s.alignSelf = FLEX_SELF[ha];
		if (va === 'middle') {
			s.marginTop = 'auto';
			s.marginBottom = 'auto';
		} else if (va === 'bottom') {
			s.marginTop = 'auto';
		}
	}
	// Expose the placement to the meter (primitive leaves only, so it doesn't leak into a group's
	// descendants): a meter whose content is smaller than its box aligns it per the leaf's halign/
	// valign via these vars instead of hard-centering. Default-less → the meter's own fallback wins.
	if (isLeaf(node) && !isGroup(node.unit)) {
		if (ha) s['--np-halign'] = HALIGN_PLACE[ha];
		if (va) s['--np-valign'] = VALIGN_PLACE[va];
	}
	return s;
}

/**
 * Style a container AS a flex/grid CONTAINER for its children: display + direction + gap + padding
 * + align/justify (or grid tracks). `overlap` stacks every child in one grid cell (the children
 * each take `gridArea:'1 / 1'` — the renderer applies that). Mirrors the solver's solveFlex/solveGrid
 * arrangement, expressed as CSS.
 */
export function containerStyle(c: Container): Style {
	const s: Style = {};
	const pad = resolvePad(c.pad);
	if (pad.t || pad.r || pad.b || pad.l) s.padding = `${pad.t}px ${pad.r}px ${pad.b}px ${pad.l}px`;
	if (c.gap) s.gap = `${c.gap}px`;

	if (c.overlap) {
		// Layered stack: one cell, every child placed at 1/1 (see overlapChildStyle).
		s.display = 'grid';
		s.gridTemplate = '"stack" 1fr / 1fr';
		return s;
	}
	if (c.kind === 'grid') {
		s.display = 'grid';
		const cols = Math.max(1, c.cols ?? 1);
		// Row count grown to fit children (mirrors solve.ts gridRows), so per-row cellH tracks line up.
		const rows = Math.max(c.rows ?? 1, Math.ceil(c.children.length / cols), 1);
		s.gridTemplateColumns = gridTemplate(c, cols, true);
		s.gridTemplateRows = gridTemplate(c, rows, false);
		s.gridAutoRows = '1fr'; // any overflow row stays uniform
		const a = GRID_ITEMS[c.align ?? 'stretch'];
		s.justifyItems = a;
		s.alignItems = a;
		return s;
	}
	s.display = 'flex';
	s.flexDirection = c.kind === 'row' ? 'row' : 'column';
	s.alignItems = ALIGN_ITEMS[c.align ?? 'stretch'];
	if (c.justify) s.justifyContent = JUSTIFY_CONTENT[c.justify];
	return s;
}

// A child of an `overlap` container occupies the single shared cell (layered by DOM order).
export function overlapChildStyle(): Style {
	return { gridArea: 'stack' };
}
