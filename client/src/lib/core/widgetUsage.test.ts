import { expect, it } from 'vitest';
import { container, group, leaf, emptyMonitorLayout } from './layoutTree';
import { createWidget } from './widget';
import { definitionUsage } from './widgetUsage';

it('counts nested shared placements independently across monitors without double-counting fallback trees', () => {
	const child = leaf(createWidget('clock', 'clock'));
	const inner = { id: 'inner', name: 'Clock', size: { w: 100, h: 40 }, child };
	const nested = leaf(group('nested', inner.size, child, { def: 'inner' }));
	const outer = {
		id: 'outer',
		name: 'Panel',
		size: inner.size,
		child: container('row', 'row', [nested])
	};
	const a = leaf(group('a', outer.size, nested, { def: 'outer' }));
	const b = leaf(group('b', inner.size, child, { def: 'inner' }));
	const monitors = {
		primary: { root: container('root', 'col', [a]), floating: [b] },
		secondary: { root: container('root2', 'col', [a]), floating: [] },
		unused: emptyMonitorLayout()
	};
	expect(definitionUsage('inner', monitors, { version: 1, defs: [inner, outer] })).toEqual([
		{ key: 'primary', count: 2 },
		{ key: 'secondary', count: 1 }
	]);
	expect(definitionUsage('outer', monitors, { version: 1, defs: [inner, outer] })).toEqual([
		{ key: 'primary', count: 1 },
		{ key: 'secondary', count: 1 }
	]);
	expect(definitionUsage('missing', monitors)).toEqual([]);
});
it('follows inline and unresolved groups, with a recursion guard for malformed references', () => {
	const node = leaf(
		group('target', { w: 40, h: 40 }, container('empty', 'col', []), { def: 'target' })
	);
	const wrapper = leaf(group('wrapper', { w: 40, h: 40 }, node));
	const monitor = { root: container('root', 'col', [wrapper]), floating: [] };
	expect(definitionUsage('target', { one: monitor })).toEqual([{ key: 'one', count: 1 }]);
	const cyclic = { id: 'target', name: 'Cycle', size: { w: 40, h: 40 }, child: node };
	expect(definitionUsage('target', { one: monitor }, { version: 1, defs: [cyclic] })).toEqual([]);
});
