// Pure geometry for the context-menu HOVER PREVIEW: given a structural layout op (split / add inside /
// add beside) and the CURRENTLY-MEASURED boxes, compute the ghost rectangles to draw on the stage so
// the user can SEE what an item will do before clicking. Inner ring (AGENTS.md §5) — no React, no DOM,
// no model mutation; just rects in → rects out, unit-tested directly.
//
// Why analytic (not a re-solve): the flow layout has no pure solver — real geometry is MEASURED from
// the DOM (useMeasuredRects → combinedSolved). But every split this previews is EVEN, and a split is
// just a tiny grid: "into rows" is a 1×2 grid, "into cols" a 2×1, "into grid" a 2×2. So we feed the
// target's measured box through the SAME `gridCellRects` solver the studio uses, carrying the target
// container's own gap/pad — the ghost then matches the post-split geometry exactly (gutters included).
// Add-inside / add-beside reflow siblings, so those show an indicative zone / insertion bar.
import type { Rect } from '../../core/layout';
import type { Container, MonitorLayout } from '../../core/layoutTree';
import { isContainer } from '../../core/layoutTree';
import { findNode, findParent } from '../../core/layoutEdit';
import { gridCellRects } from '../../core/solve';
import type { LayoutOp } from '../ops';

export type PreviewShape =
	// An outlined region — the structure a split will create (e.g. the cell that keeps existing content).
	| { kind: 'cell'; rect: Rect }
	// A filled region — NEW space the op opens up (a new split cell, or the container an add targets).
	| { kind: 'zone'; rect: Rect }
	// An insertion line — where an add-beside sibling (or an add-inside append) will land.
	| { kind: 'bar'; rect: Rect; axis: 'row' | 'col' };

// An empty grid placeholder cell (Canvas's gridPlaceholders), used as the split/add target when the
// menu was opened from an empty cell (op carries its index).
export type PreviewCell = { gridId: string; index: number; rect: Rect };

// World-coord thickness of an insertion bar. Kept modest; it's a hint, not a hit target.
const BAR = 4;

// The even regions a split produces, solved through `gridCellRects` (so pad/gap match the real op):
// cols → a 2×1 grid, rows → 1×2, grid → 2×2. `gap`/`pad` come from the container being split (a
// cell-scoped split materialises a fresh band with default spacing → undefined). Row-major order, so
// region 0 is the left/top/top-left one (where splitNode keeps existing content).
function splitRegions(
	box: Rect,
	dir: 'rows' | 'cols' | 'grid',
	gap: number | undefined,
	pad: Container['pad']
): Rect[] {
	const [cols, rows] = dir === 'cols' ? [2, 1] : dir === 'rows' ? [1, 2] : [2, 2];
	const synthetic: Container = {
		id: '__preview__',
		kind: 'grid',
		cols,
		rows,
		gap,
		pad,
		children: Array.from({ length: cols * rows }, (_, i): Container => ({
			id: `__pc${i}`,
			kind: 'col',
			children: []
		}))
	};
	return gridCellRects(synthetic, box);
}

// An insertion bar centred on a node's trailing edge along the parent's main axis: a `row` parent lays
// siblings side-by-side (a vertical bar at the right edge), a `col` stacks them (a horizontal bar at
// the bottom edge). `axis` names the PARENT'S kind so the renderer can pick orientation.
function afterBar(box: Rect, axis: 'row' | 'col'): PreviewShape {
	if (axis === 'col') {
		return { kind: 'bar', axis, rect: { x: box.x, y: box.y + box.h - BAR / 2, w: box.w, h: BAR } };
	}
	return { kind: 'bar', axis, rect: { x: box.x + box.w - BAR / 2, y: box.y, w: BAR, h: box.h } };
}

/**
 * Compute the ghost shapes for a previewable op, or `[]` when nothing can be drawn (op isn't
 * previewable, or its target box hasn't been measured yet).
 * @param boxes  measured world-coord box per node id (Canvas's combinedSolved).
 * @param cells  empty grid placeholders (Canvas's gridPlaceholders) — the target for a cell-scoped op.
 * @param workArea  the stage work area, used as the root container's box (root isn't always measured).
 */
export function buildMenuPreview(
	op: LayoutOp,
	monitor: MonitorLayout,
	boxes: Map<string, Rect>,
	cells: PreviewCell[],
	workArea: Rect
): PreviewShape[] {
	// The measured box of a target: an explicit grid cell (when the op is cell-scoped), else the node's
	// own measured box, falling back to the work area for the (sometimes-unmeasured) root container.
	const boxFor = (id: string, cellIndex?: number): Rect | undefined => {
		if (cellIndex !== undefined) {
			const c = cells.find((cc) => cc.gridId === id && cc.index === cellIndex);
			if (c) return c.rect;
		}
		return boxes.get(id) ?? (id === monitor.root.id ? workArea : undefined);
	};

	switch (op.op) {
		case 'split': {
			const box = boxFor(op.id, op.cellIndex);
			if (!box) return [];
			// A cell-scoped split targets an empty cell (no kept content, default spacing); an in-place
			// container split RETAINS the container's gap/pad (splitNode's `...node` spread).
			const node = op.cellIndex === undefined ? findNode(monitor.root, op.id) : null;
			const cont = node && isContainer(node) ? node : null;
			const regions = splitRegions(box, op.dir, cont?.gap, cont?.pad);
			const keepsContent = cont !== null && cont.children.length > 0;
			return regions.map((rect, i) => ({ kind: keepsContent && i === 0 ? 'cell' : 'zone', rect }));
		}
		case 'addContainer': {
			// The context menu always sets containerId (Outline's +Row/+Col can omit it → no preview).
			if (op.containerId === undefined) return [];
			const box = boxFor(op.containerId, op.index);
			if (!box) return [];
			const shapes: PreviewShape[] = [{ kind: 'zone', rect: box }];
			// A non-empty row/col gets an insertion bar at its trailing edge (where the appended child
			// lands). Skip it for a grid (children pick the next cell, not the main axis) and for an
			// `overlap` container (children STACK over the whole box, so a bottom bar would mislead).
			const node = op.index === undefined ? findNode(monitor.root, op.containerId) : null;
			if (
				node &&
				isContainer(node) &&
				node.children.length > 0 &&
				node.kind !== 'grid' &&
				!node.overlap
			) {
				shapes.push(afterBar(box, node.kind));
			}
			return shapes;
		}
		case 'addBeside': {
			const box = boxes.get(op.id);
			if (!box) return [];
			const parent = findParent(monitor.root, op.id);
			// A grid parent flows row-major: the new sibling lands in the NEXT cell (which may wrap to the
			// next row), not simply to the right — so a directional bar would mislead. Outline the slot the
			// band lands in instead (solve the reflowed grid), falling back to the node's own cell box.
			if (parent?.kind === 'grid') {
				const gridBox = boxes.get(parent.id);
				const idx = parent.children.findIndex((c) => c.id === op.id);
				if (gridBox && idx >= 0) {
					const reflowed: Container = {
						...parent,
						children: [
							...parent.children.slice(0, idx + 1),
							{ id: '__pcb', kind: 'col', children: [] },
							...parent.children.slice(idx + 1)
						]
					};
					const slot = gridCellRects(reflowed, gridBox)[idx + 1];
					if (slot) return [{ kind: 'zone', rect: slot }];
				}
				return [{ kind: 'zone', rect: box }];
			}
			// row parent → a vertical bar after the node; col parent → a horizontal bar below it.
			const axis: 'row' | 'col' = parent?.kind === 'col' ? 'col' : 'row';
			return [afterBar(box, axis)];
		}
		default:
			return [];
	}
}
