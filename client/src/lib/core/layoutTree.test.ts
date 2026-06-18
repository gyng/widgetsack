import { describe, expect, it } from 'vitest';
import type { WidgetInstance } from './layout';
import {
	container,
	emptyMonitorLayout,
	emptyRoot,
	group,
	isContainer,
	isGroup,
	isLeaf,
	leaf,
	monitorHasWidgets,
	resolvePad,
	ROOT_PAD,
	type Group
} from './layoutTree';

const prim = (id: string): WidgetInstance => ({
	id,
	type: 'gauge',
	rect: { x: 0, y: 0, w: 10, h: 10 },
	config: {}
});

describe('constructors', () => {
	it('emptyRoot is an empty padded col that stretches its children', () => {
		expect(emptyRoot()).toEqual({
			id: 'root',
			kind: 'col',
			children: [],
			align: 'stretch',
			pad: ROOT_PAD
		});
	});

	it('emptyMonitorLayout pairs an empty root with no floating', () => {
		expect(emptyMonitorLayout()).toEqual({
			root: { id: 'root', kind: 'col', children: [], align: 'stretch', pad: ROOT_PAD },
			floating: []
		});
	});

	it('container merges opts', () => {
		const c = container('c', 'grid', [], { cols: 3, gap: 8 });
		expect(c).toMatchObject({ id: 'c', kind: 'grid', cols: 3, gap: 8, children: [] });
	});

	it('leaf takes its id from the unit and omits basis by default', () => {
		const lf = leaf(prim('w1'));
		expect(lf).toEqual({ id: 'w1', unit: prim('w1') });
		expect('basis' in lf).toBe(false);
	});

	it('leaf carries an explicit basis', () => {
		expect(leaf(prim('w1'), { fr: 2 })).toMatchObject({ id: 'w1', basis: { fr: 2 } });
	});

	it('group builds a kind:group unit with opts', () => {
		const g = group('g', { w: 40, h: 26 }, leaf(prim('x')), { name: 'Core', def: 'cg' });
		expect(g).toMatchObject({ id: 'g', kind: 'group', name: 'Core', def: 'cg' });
		expect(g.size).toEqual({ w: 40, h: 26 });
	});
});

describe('resolvePad', () => {
	it('undefined → zero on all sides', () => {
		expect(resolvePad(undefined)).toEqual({ t: 0, r: 0, b: 0, l: 0 });
	});
	it('number → same on all sides', () => {
		expect(resolvePad(6)).toEqual({ t: 6, r: 6, b: 6, l: 6 });
	});
	it('object → passthrough', () => {
		expect(resolvePad({ t: 1, r: 2, b: 3, l: 4 })).toEqual({ t: 1, r: 2, b: 3, l: 4 });
	});
});

describe('guards', () => {
	it('isContainer / isLeaf discriminate nodes', () => {
		const c = container('c', 'row', []);
		const lf = leaf(prim('w'));
		expect(isContainer(c)).toBe(true);
		expect(isContainer(lf)).toBe(false);
		expect(isLeaf(lf)).toBe(true);
		expect(isLeaf(c)).toBe(false);
	});

	it('isGroup distinguishes a group unit from a primitive', () => {
		const g: Group = group('g', { w: 1, h: 1 }, leaf(prim('x')));
		expect(isGroup(g)).toBe(true);
		expect(isGroup(prim('w'))).toBe(false);
	});
});

describe('monitorHasWidgets', () => {
	it('is false for an empty monitor', () => {
		expect(monitorHasWidgets(emptyMonitorLayout())).toBe(false);
	});

	it('is true when there is a floating widget', () => {
		expect(monitorHasWidgets({ ...emptyMonitorLayout(), floating: [leaf(prim('f'))] })).toBe(true);
	});

	it('is true for a leaf anywhere in the flow tree, false for empty containers', () => {
		const nested = {
			...emptyMonitorLayout(),
			root: container('r', 'col', [container('c', 'row', [])])
		};
		expect(monitorHasWidgets(nested)).toBe(false);
		const withLeaf = { ...emptyMonitorLayout(), root: container('r', 'col', [leaf(prim('w'))]) };
		expect(monitorHasWidgets(withLeaf)).toBe(true);
	});
});
