import { gridDimensions, normalizeGridTrackCount, validGridTrackCount } from './gridDimensions';
import { describe, expect, it } from 'vitest';
import { container } from './layoutTree';
import { gridCellRects } from './solve';
import { containerStyle } from './flowStyle';
import { parseLayoutNode } from './migration';
describe('grid count safety', () => {
	it.each([undefined, null, '2', NaN, Infinity, -Infinity])(
		'uses one track for non-finite or nonnumeric input %s',
		(value) => {
			expect(normalizeGridTrackCount(value)).toBe(1);
			expect(validGridTrackCount(value)).toBe(false);
		}
	);
	it.each([
		[0, 1],
		[-5, 1],
		[2.9, 2],
		[64, 64],
		[1e12, 64]
	])('bounds numeric input %s to %s', (value, expected) => {
		expect(normalizeGridTrackCount(value)).toBe(expected);
		expect(validGridTrackCount(value)).toBe(value === 64);
	});
	it('accepts integer boundary counts and grows automatic rows without discarding children', () => {
		expect(validGridTrackCount(1)).toBe(true);
		expect(validGridTrackCount(2)).toBe(true);
		const children = Array.from({ length: 65 }, (_, i) => container(String(i), 'col', []));
		expect(gridDimensions({ cols: 1, rows: 1, children })).toEqual({ cols: 1, rows: 65 });
	});
	it('uses whole tracks consistently in CSS and editor geometry', () => {
		const grid = container('grid', 'grid', [], { cols: 2.5, rows: 1.5 });
		const cells = gridCellRects(grid, { x: 0, y: 0, w: 100, h: 50 });
		expect(cells).toEqual([
			{ x: 0, y: 0, w: 50, h: 50 },
			{ x: 50, y: 0, w: 50, h: 50 }
		]);
		expect(containerStyle(grid)).toMatchObject({
			gridTemplateColumns: 'repeat(2, 1fr)',
			gridTemplateRows: 'repeat(1, 1fr)'
		});
	});
	it('bounds parsed track counts before they reach array allocation', () => {
		const parsed = parseLayoutNode({
			id: 'grid',
			kind: 'grid',
			children: [],
			cols: 1e12,
			rows: 1e12
		});
		expect(parsed).toHaveProperty('cols', 64);
		expect(parsed).toHaveProperty('rows', 64);
	});
});
