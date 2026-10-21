import { expect, it } from 'vitest';
import { container, emptyMonitorLayout, group, leaf } from './layoutTree';
import { createWidget } from './widget';
import { planArrangement } from './arrangement';
const widget = (id: string, x: number, y: number, w = 40, h = 20) =>
	leaf({ ...createWidget('clock', id), rect: { x, y, w, h } });
const monitor = () => ({
	root: container('root', 'col', []),
	floating: [widget('a', 20, 20), widget('b', 100, 80), widget('c', 220, 140)]
});
it('previews floating rows, stacks and equal spacing without changing its input', () => {
	const source = monitor();
	expect(
		planArrangement(source, ['c', 'a', 'b'], 'column').monitor?.floating.map((item) =>
			'rect' in item.unit ? item.unit.rect : null
		)
	).toEqual([
		{ x: 20, y: 20, w: 40, h: 20 },
		{ x: 20, y: 48, w: 40, h: 20 },
		{ x: 20, y: 76, w: 40, h: 20 }
	]);
	expect(planArrangement(source, ['a', 'b', 'c'], 'row').monitor?.floating[1].unit).toMatchObject({
		rect: { x: 68, y: 20 }
	});
	expect(
		planArrangement(source, ['a', 'b', 'c'], 'space-horizontal').monitor?.floating[1].unit
	).toMatchObject({ rect: { x: 120 } });
	expect(
		planArrangement(source, ['a', 'b', 'c'], 'space-vertical').monitor?.floating[1].unit
	).toMatchObject({ rect: { y: 80 } });
	expect(source).toEqual(monitor());
});
it('arranges a container or selected flow siblings while keeping unrelated siblings', () => {
	const source = {
		root: container('root', 'col', [widget('a', 0, 0), widget('b', 0, 0), widget('c', 0, 0)]),
		floating: []
	};
	expect(planArrangement(source, ['root'], 'row').monitor?.root).toMatchObject({
		kind: 'row',
		gap: 8
	});
	const changed = planArrangement(source, ['a', 'b'], 'column', undefined, new Map(), 'stack');
	expect(changed.monitor?.root.children.map((item) => item.id)).toEqual(['stack', 'c']);
	expect(changed.monitor?.root.children[0]).toMatchObject({
		kind: 'col',
		children: [{ id: 'a' }, { id: 'b' }]
	});
	expect(planArrangement(source, ['root'], 'space-horizontal').monitor?.root).toMatchObject({
		kind: 'row',
		justify: 'between',
		gap: 0
	});
});
it('fits authored content sizes, including reusable groups, without changing their definition', () => {
	const source = {
		root: container('root', 'col', [widget('flow', 0, 0)]),
		floating: [
			widget('a', 20, 20),
			leaf(
				group('g', { w: 200, h: 100 }, container('content', 'row', [widget('inner', 0, 0)]), {
					config: { x: 80, y: 40 }
				})
			)
		]
	};
	const changed = planArrangement(
		source,
		['a', 'g'],
		'fit',
		undefined,
		new Map([['a', { x: 0, y: 0, w: 90, h: 28 }]])
	);
	expect(changed.monitor?.floating[0].unit).toMatchObject({ rect: { x: 20, y: 20, w: 90, h: 28 } });
	expect(changed.monitor?.floating[1].unit).toMatchObject({
		config: { x: 80, y: 40, w: 40, h: 20 }
	});
	expect(planArrangement(source, ['root'], 'fit').monitor?.root.bounds).toMatchObject({
		w: 40,
		h: 20
	});
	expect(planArrangement(source, ['flow'], 'fit').monitor?.root.children[0]).toMatchObject({
		basis: 'content'
	});
});
it('explains empty, missing, mixed and unrelated selections without mutating them', () => {
	const empty = emptyMonitorLayout();
	expect(planArrangement(empty, [], 'row').message).toBeTruthy();
	expect(planArrangement(empty, ['missing'], 'row').message).toBeTruthy();
	const source = monitor();
	source.root.children.push(widget('flow', 0, 0));
	expect(planArrangement(source, ['a', 'flow'], 'row').message).toBeTruthy();
	source.root.children.push(container('other', 'row', [widget('inside', 0, 0)]));
	expect(planArrangement(source, ['flow', 'inside'], 'row').message).toBeTruthy();
	expect(planArrangement(source, ['a'], 'space-horizontal').message).toBeTruthy();
});

it('previews flow spacing against the measured container content area, including padding', () => {
	const source = {
		root: container('root', 'col', [widget('a', 0, 0), widget('b', 0, 0)], { pad: 16 }),
		floating: []
	};
	const boxes = new Map([
		['root', { x: 0, y: 0, w: 300, h: 120 }],
		['a', { x: 16, y: 16, w: 268, h: 20 }],
		['b', { x: 16, y: 44, w: 268, h: 20 }]
	]);
	const horizontal = planArrangement(source, ['root'], 'space-horizontal', undefined, boxes);
	expect(horizontal.after).toEqual([
		{ x: 16, y: 16, w: 40, h: 20 },
		{ x: 244, y: 16, w: 40, h: 20 }
	]);
	const vertical = planArrangement(source, ['root'], 'space-vertical', undefined, boxes);
	expect(vertical.after[1]).toMatchObject({ x: 16, y: 84 });
});

it('bounds an equal-spacing wrapper around selected flow siblings', () => {
	const source = {
		root: container('root', 'col', [widget('a', 0, 0), widget('b', 80, 0), widget('keep', 180, 0)]),
		floating: []
	};
	for (const mode of ['space-horizontal', 'space-vertical'] as const) {
		const planned = planArrangement(source, ['a', 'b'], mode);
		expect(planned.monitor?.root.children).toHaveLength(2);
		expect(planned.monitor?.root.children[0]).toMatchObject({
			id: 'arranged-selection',
			justify: 'between',
			bounds: { x: 0, y: 0, w: expect.any(Number), h: expect.any(Number) }
		});
	}
});

it('distributes floating items in their visual order while preserving the other axis', () => {
	const source = {
		root: container('root', 'col', []),
		floating: [widget('last', 220, 140), widget('first', 20, 20), widget('middle', 100, 80)]
	};
	const horizontal = planArrangement(
		source,
		['last', 'first', 'middle'],
		'space-horizontal'
	).monitor!;
	expect(horizontal.floating.map((node) => ('rect' in node.unit ? node.unit.rect : null))).toEqual([
		{ x: 220, y: 140, w: 40, h: 20 },
		{ x: 20, y: 20, w: 40, h: 20 },
		{ x: 120, y: 80, w: 40, h: 20 }
	]);
	const vertical = planArrangement(source, ['last', 'first', 'middle'], 'space-vertical').monitor!;
	expect(vertical.floating[2].unit).toMatchObject({ rect: { x: 100, y: 80 } });
});

it('previews sibling order consistently even when selection was made backwards', () => {
	const source = {
		root: container('root', 'col', [widget('a', 0, 0, 30), widget('b', 0, 40, 70)]),
		floating: []
	};
	const plan = planArrangement(source, ['b', 'a'], 'row');
	expect(plan.after).toEqual([
		{ x: 0, y: 0, w: 30, h: 20 },
		{ x: 38, y: 0, w: 70, h: 20 }
	]);
	expect(plan.monitor?.root.children[0]).toMatchObject({ children: [{ id: 'a' }, { id: 'b' }] });
});

it('sorts a reversed vertical floating selection by visual position', () => {
	const source = {
		root: container('root', 'col', []),
		floating: [widget('last', 10, 120), widget('first', 30, 0), widget('middle', 20, 40)]
	};
	const result = planArrangement(source, ['last', 'first', 'middle'], 'space-vertical');
	expect(result.after.map((r) => r.y)).toEqual([120, 0, 60]);
});

it('keeps unselected floating items in place while arranging a subset', () => {
	const source = monitor();
	const plan = planArrangement(source, ['a', 'b'], 'row');
	expect(plan.monitor?.floating[2]).toBe(source.floating[2]);
});
