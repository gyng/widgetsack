import { expect, it } from 'vitest';
import { initialEditorState } from '../../core/editorReducer';
import { emptyMonitorLayout, container, group, leaf } from '../../core/layoutTree';
import { createWidget } from '../../core/widget';
import { saveSelectionWidget, canSaveSelectionWidget } from './selectionWidget';
const item = (id: string, x: number) =>
	leaf({ ...createWidget('clock', id), rect: { x, y: 20, w: 40, h: 20 } });
it('saves floating widgets as one reusable panel with local positions and one desktop placement', () => {
	const state = {
		...initialEditorState(true, emptyMonitorLayout()),
		monitor: {
			root: container('root', 'col', []),
			floating: [item('a', 20), item('b', 80), item('keep', 200)]
		}
	};
	const patch = saveSelectionWidget(state, ['a', 'b'], 'panel', 'def');
	expect(patch.library?.defs[0]).toMatchObject({
		id: 'def',
		name: 'Custom panel',
		size: { w: 100, h: 20 },
		child: {
			overlap: true,
			children: [{ unit: { rect: { x: 0, y: 0 } } }, { unit: { rect: { x: 60, y: 0 } } }]
		}
	});
	expect(patch.monitor?.floating.map((node) => node.id)).toEqual(['keep', 'panel']);
	expect(patch.monitor?.floating[1].unit).toMatchObject({ def: 'def', config: { x: 20, y: 20 } });
	expect(state.monitor.floating).toHaveLength(3);
});
it('saves flow siblings in place and refuses selections which cannot form one panel', () => {
	const state = {
		...initialEditorState(true, emptyMonitorLayout()),
		monitor: {
			root: container('root', 'row', [item('a', 0), item('b', 0), item('keep', 0)], { gap: 8 }),
			floating: [] as ReturnType<typeof leaf>[]
		}
	};
	const patch = saveSelectionWidget(state, ['b', 'a'], 'panel', 'def');
	expect(patch.monitor?.root.children.map((node) => node.id)).toEqual(['panel', 'keep']);
	expect(patch.library?.defs[0].child).toMatchObject({
		kind: 'row',
		children: [{ id: 'a' }, { id: 'b' }]
	});
	expect(canSaveSelectionWidget(state.monitor, ['a', 'b'])).toBe(true);
	expect(saveSelectionWidget(state, ['a'], 'bad', 'bad')).toEqual({});
	state.monitor.floating.push(item('floating', 100));
	expect(canSaveSelectionWidget(state.monitor, ['a', 'floating'])).toBe(false);
	expect(canSaveSelectionWidget(state.monitor, ['a', 'missing'])).toBe(false);
	state.monitor.root.children.push(container('nested', 'col', [item('inside', 0)]));
	expect(canSaveSelectionWidget(state.monitor, ['a', 'inside'])).toBe(false);
});

it('keeps existing library entries and nested floating group anchors when saving a panel', () => {
	const child = container('inside', 'col', [item('nested-clock', 0)]);
	const nested = leaf(group('group', { w: 100, h: 30 }, child));
	const state = {
		...initialEditorState(true, emptyMonitorLayout()),
		library: {
			version: 3,
			defs: [{ id: 'existing', name: 'Existing', size: { w: 100, h: 30 }, child }]
		},
		monitor: { root: container('root', 'col', []), floating: [nested, item('clock', 160)] }
	};
	const fallback = saveSelectionWidget(state, ['group', 'clock'], 'panel', 'new');
	expect(fallback.library?.version).toBe(3);
	expect(fallback.library?.defs[0]).toBe(state.library.defs[0]);
	expect(fallback.library?.defs[1].child).toMatchObject({
		children: [
			{ unit: { config: { x: 0, y: 0, w: 100, h: 30 } } },
			{ id: 'clock', unit: { rect: { x: 160, y: 20, w: 40, h: 20 } } }
		]
	});
	const measured = saveSelectionWidget(
		state,
		['group', 'clock'],
		'panel',
		'new',
		new Map([['group', { x: 40, y: 20, w: 120, h: 40 }]])
	);
	expect(measured.monitor?.floating[0].unit).toMatchObject({ config: { x: 40, y: 20 } });
	expect(canSaveSelectionWidget(state.monitor, ['root', 'clock'])).toBe(false);
});
