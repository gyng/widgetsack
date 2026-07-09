import { describe, expect, it } from 'vitest';
import { buildMenuPreview, type PreviewCell } from './menuPreview';
import type { Container, MonitorLayout } from '../../core/layoutTree';
import type { Rect } from '../../core/layout';
import type { LayoutOp } from '../ops';

const cont = (id: string, kind: Container['kind'], children: Container[] = []): Container => ({
	id,
	kind,
	children
});

// root(col) ─┬ a(row, has 1 child)
//            └ b(grid, empty)
const monitor = (): MonitorLayout => ({
	root: cont('root', 'col', [cont('a', 'row', [cont('a1', 'row')]), cont('b', 'grid')]),
	floating: []
});

const boxes = (entries: Record<string, Rect>): Map<string, Rect> =>
	new Map(Object.entries(entries));
const WORK: Rect = { x: 0, y: 0, w: 200, h: 160 };

describe('buildMenuPreview — split', () => {
	const aBox: Rect = { x: 0, y: 0, w: 100, h: 80 };

	it('into columns: two vertical regions, kept content outlined, new space filled', () => {
		const op: LayoutOp = { op: 'split', id: 'a', dir: 'cols' };
		const shapes = buildMenuPreview(op, monitor(), boxes({ a: aBox }), [], WORK);
		expect(shapes).toEqual([
			{ kind: 'cell', rect: { x: 0, y: 0, w: 50, h: 80 } },
			{ kind: 'zone', rect: { x: 50, y: 0, w: 50, h: 80 } }
		]);
	});

	it('into rows: two horizontal regions (kept on top)', () => {
		const op: LayoutOp = { op: 'split', id: 'a', dir: 'rows' };
		const shapes = buildMenuPreview(op, monitor(), boxes({ a: aBox }), [], WORK);
		expect(shapes).toEqual([
			{ kind: 'cell', rect: { x: 0, y: 0, w: 100, h: 40 } },
			{ kind: 'zone', rect: { x: 0, y: 40, w: 100, h: 40 } }
		]);
	});

	it('into 2x2 grid: four quadrants, region 0 kept, three new', () => {
		const op: LayoutOp = { op: 'split', id: 'a', dir: 'grid' };
		const shapes = buildMenuPreview(op, monitor(), boxes({ a: aBox }), [], WORK);
		expect(shapes.map((s) => s.kind)).toEqual(['cell', 'zone', 'zone', 'zone']);
		expect(shapes[3].rect).toEqual({ x: 50, y: 40, w: 50, h: 40 });
	});

	it('splitting an EMPTY container marks every region as new (nothing kept)', () => {
		const op: LayoutOp = { op: 'split', id: 'b', dir: 'cols' };
		const shapes = buildMenuPreview(
			op,
			monitor(),
			boxes({ b: { x: 0, y: 0, w: 80, h: 80 } }),
			[],
			WORK
		);
		expect(shapes.map((s) => s.kind)).toEqual(['zone', 'zone']);
	});

	it('a cell-scoped split targets the empty cell box and keeps nothing', () => {
		const op: LayoutOp = { op: 'split', id: 'b', dir: 'grid', cellIndex: 2 };
		const cells: PreviewCell[] = [{ gridId: 'b', index: 2, rect: { x: 10, y: 10, w: 40, h: 40 } }];
		const shapes = buildMenuPreview(
			op,
			monitor(),
			boxes({ b: { x: 0, y: 0, w: 80, h: 80 } }),
			cells,
			WORK
		);
		expect(shapes.map((s) => s.kind)).toEqual(['zone', 'zone', 'zone', 'zone']);
		// subdivides the CELL, not the whole grid
		expect(shapes[0].rect).toEqual({ x: 10, y: 10, w: 20, h: 20 });
	});

	it('a cell-scoped split whose placeholder is missing falls back to the node box', () => {
		// The op carries a cellIndex but the placeholder list has no matching cell (stale menu after a
		// re-measure) — boxFor falls through to the grid's own measured box, still keeping nothing.
		const op: LayoutOp = { op: 'split', id: 'b', dir: 'cols', cellIndex: 2 };
		const shapes = buildMenuPreview(
			op,
			monitor(),
			boxes({ b: { x: 0, y: 0, w: 80, h: 80 } }),
			[],
			WORK
		);
		expect(shapes).toEqual([
			{ kind: 'zone', rect: { x: 0, y: 0, w: 40, h: 80 } },
			{ kind: 'zone', rect: { x: 40, y: 0, w: 40, h: 80 } }
		]);
	});

	it('falls back to the work area for the (unmeasured) root container', () => {
		const op: LayoutOp = { op: 'split', id: 'root', dir: 'cols' };
		const shapes = buildMenuPreview(op, monitor(), boxes({}), [], WORK);
		expect(shapes[0].rect).toEqual({ x: 0, y: 0, w: 100, h: 160 });
	});

	it('returns nothing when the target box is unmeasured', () => {
		const op: LayoutOp = { op: 'split', id: 'a', dir: 'cols' };
		expect(buildMenuPreview(op, monitor(), boxes({}), [], WORK)).toEqual([]);
	});

	it("carries the container's own gap + pad so the ghost matches the real (spaced) split", () => {
		// A row with pad:8 (all sides) and gap:10 → the split children inset by 8 and split by 10, just
		// like the solver does (the new parent retains gap/pad). Box 100×80 → content 84×64.
		const m: MonitorLayout = {
			root: cont('root', 'col', [
				{ id: 'g', kind: 'row', gap: 10, pad: 8, children: [cont('g1', 'row')] }
			]),
			floating: []
		};
		const op: LayoutOp = { op: 'split', id: 'g', dir: 'cols' };
		const shapes = buildMenuPreview(op, m, boxes({ g: { x: 0, y: 0, w: 100, h: 80 } }), [], WORK);
		expect(shapes).toEqual([
			{ kind: 'cell', rect: { x: 8, y: 8, w: 37, h: 64 } },
			{ kind: 'zone', rect: { x: 55, y: 8, w: 37, h: 64 } }
		]);
	});
});

describe('buildMenuPreview — add inside', () => {
	it('a non-empty row gets a zone over it plus a trailing vertical insertion bar', () => {
		const op: LayoutOp = { op: 'addContainer', kind: 'col', containerId: 'a' };
		const aBox: Rect = { x: 0, y: 0, w: 100, h: 80 };
		const shapes = buildMenuPreview(op, monitor(), boxes({ a: aBox }), [], WORK);
		expect(shapes[0]).toEqual({ kind: 'zone', rect: aBox });
		expect(shapes[1]).toMatchObject({ kind: 'bar', axis: 'row' });
		expect(shapes[1].rect.x).toBeCloseTo(98); // right edge minus half the bar width
	});

	it('an empty container shows only the zone (no bar)', () => {
		const op: LayoutOp = { op: 'addContainer', kind: 'row', containerId: 'b' };
		const shapes = buildMenuPreview(
			op,
			monitor(),
			boxes({ b: { x: 0, y: 0, w: 80, h: 80 } }),
			[],
			WORK
		);
		expect(shapes).toHaveLength(1);
		expect(shapes[0].kind).toBe('zone');
	});

	it('a cell-scoped add targets the empty cell and shows only the zone', () => {
		const op: LayoutOp = { op: 'addContainer', kind: 'row', containerId: 'b', index: 1 };
		const cells: PreviewCell[] = [{ gridId: 'b', index: 1, rect: { x: 5, y: 5, w: 30, h: 30 } }];
		const shapes = buildMenuPreview(op, monitor(), boxes({}), cells, WORK);
		expect(shapes).toEqual([{ kind: 'zone', rect: { x: 5, y: 5, w: 30, h: 30 } }]);
	});

	it('returns nothing when the op carries no containerId (Outline’s +Row/+Col)', () => {
		const op: LayoutOp = { op: 'addContainer', kind: 'row' };
		expect(
			buildMenuPreview(op, monitor(), boxes({ a: { x: 0, y: 0, w: 10, h: 10 } }), [], WORK)
		).toEqual([]);
	});

	it('returns nothing when the target container box is unmeasured', () => {
		const op: LayoutOp = { op: 'addContainer', kind: 'row', containerId: 'a' };
		expect(buildMenuPreview(op, monitor(), boxes({}), [], WORK)).toEqual([]);
	});

	it('an OVERLAP (stacking) container shows only the zone — no trailing bar (the child stacks)', () => {
		const m: MonitorLayout = {
			root: cont('root', 'col', [
				{ id: 'ov', kind: 'col', overlap: true, children: [cont('ov1', 'row')] }
			]),
			floating: []
		};
		const op: LayoutOp = { op: 'addContainer', kind: 'row', containerId: 'ov' };
		const shapes = buildMenuPreview(op, m, boxes({ ov: { x: 0, y: 0, w: 80, h: 80 } }), [], WORK);
		expect(shapes).toHaveLength(1);
		expect(shapes[0].kind).toBe('zone');
	});
});

describe('buildMenuPreview — add beside', () => {
	it('in a col parent: a horizontal bar below the node', () => {
		const op: LayoutOp = { op: 'addBeside', kind: 'row', id: 'a' };
		const aBox: Rect = { x: 0, y: 0, w: 100, h: 80 };
		const shapes = buildMenuPreview(op, monitor(), boxes({ a: aBox }), [], WORK);
		expect(shapes).toHaveLength(1);
		expect(shapes[0]).toMatchObject({ kind: 'bar', axis: 'col' });
		expect(shapes[0].rect.y).toBeCloseTo(78);
		expect(shapes[0].rect.w).toBe(100);
	});

	it('in a row parent: a vertical bar after the node', () => {
		const op: LayoutOp = { op: 'addBeside', kind: 'col', id: 'a1' }; // a1's parent `a` is a row
		const a1Box: Rect = { x: 0, y: 0, w: 60, h: 80 };
		const shapes = buildMenuPreview(op, monitor(), boxes({ a1: a1Box }), [], WORK);
		expect(shapes).toHaveLength(1);
		expect(shapes[0]).toMatchObject({ kind: 'bar', axis: 'row' });
		expect(shapes[0].rect.x).toBeCloseTo(58); // right edge minus half the bar width
		expect(shapes[0].rect.h).toBe(80);
	});

	it('returns nothing when the node box is unmeasured', () => {
		const op: LayoutOp = { op: 'addBeside', kind: 'row', id: 'a' };
		expect(buildMenuPreview(op, monitor(), boxes({}), [], WORK)).toEqual([]);
	});

	it('a GRID parent outlines the cell the new band lands in (no misleading side bar)', () => {
		// grid(2 cols) with cells [a,b,c]; "Add beside a" inserts at index 1 → the new band takes the
		// top-right cell of the reflowed 2×2 grid.
		const m: MonitorLayout = {
			root: cont('root', 'col', [
				{
					id: 'gp',
					kind: 'grid',
					cols: 2,
					children: [cont('a', 'row'), cont('b', 'row'), cont('c', 'row')]
				}
			]),
			floating: []
		};
		const op: LayoutOp = { op: 'addBeside', kind: 'row', id: 'a' };
		const shapes = buildMenuPreview(
			op,
			m,
			boxes({ gp: { x: 0, y: 0, w: 100, h: 100 }, a: { x: 0, y: 0, w: 50, h: 50 } }),
			[],
			WORK
		);
		expect(shapes).toEqual([{ kind: 'zone', rect: { x: 50, y: 0, w: 50, h: 50 } }]);
	});

	it('a GRID parent falls back to the node cell when the grid box is unmeasured', () => {
		const m: MonitorLayout = {
			root: cont('root', 'col', [
				{ id: 'gp', kind: 'grid', cols: 2, children: [cont('a', 'row'), cont('b', 'row')] }
			]),
			floating: []
		};
		const op: LayoutOp = { op: 'addBeside', kind: 'row', id: 'a' };
		const shapes = buildMenuPreview(op, m, boxes({ a: { x: 0, y: 0, w: 50, h: 50 } }), [], WORK);
		expect(shapes).toEqual([{ kind: 'zone', rect: { x: 0, y: 0, w: 50, h: 50 } }]);
	});
});

describe('buildMenuPreview — non-previewable ops', () => {
	it('returns [] for ops that do not change structure geometry', () => {
		for (const op of [
			{ op: 'remove', id: 'a' },
			{ op: 'select', id: 'a' },
			{ op: 'makeWidget', id: 'a' }
		] as LayoutOp[]) {
			expect(
				buildMenuPreview(op, monitor(), boxes({ a: { x: 0, y: 0, w: 10, h: 10 } }), [], WORK)
			).toEqual([]);
		}
	});
});
