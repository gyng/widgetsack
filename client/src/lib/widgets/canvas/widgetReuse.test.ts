import { makeWidget } from './editorOps';
import { expect, it } from 'vitest';
import { initialEditorState } from '../../core/editorReducer';
import { container, group, leaf, emptyMonitorLayout } from '../../core/layoutTree';
import { createWidget } from '../../core/widget';
import { makeIndependentCopy } from './widgetReuse';

it('gives only the selected placement an independent definition while preserving its parameters, style and anchor', () => {
	const source = {
		id: 'shared',
		name: 'Desk clock',
		size: { w: 140, h: 40 },
		child: leaf(createWidget('clock', 'clock')),
		css: 'color: red',
		params: [{ key: 'format', target: 'unit.config.format', default: 'HH:mm' }]
	};
	const placement = group('one', source.size, source.child, {
		def: source.id,
		params: { format: 'HH' },
		config: { x: 12, y: 28 },
		tokens: { '--np-fg': 'blue' }
	});
	const other = group('two', source.size, source.child, { def: source.id });
	const state = {
		...initialEditorState(true, emptyMonitorLayout()),
		library: { version: 1, defs: [source] },
		monitor: { root: container('root', 'col', [leaf(other)]), floating: [leaf(placement)] }
	};
	const patch = makeIndependentCopy(state, 'one', 'private');
	expect(patch.library?.defs[1]).toEqual({ ...source, id: 'private', name: 'Desk clock copy' });
	expect(patch.monitor?.floating[0].unit).toMatchObject({
		...placement,
		def: 'private',
		name: 'Desk clock copy'
	});
	expect(patch.monitor?.root.children[0]).toEqual(leaf(other));
	expect(state.library.defs).toEqual([source]);
	const flowState = {
		...state,
		monitor: { root: container('root', 'col', [leaf(placement)]), floating: [] }
	};
	expect(
		makeIndependentCopy(flowState, 'one', 'flow-copy').monitor?.root.children[0]
	).toMatchObject({ unit: { def: 'flow-copy' } });
});
it('ignores missing, primitive, inline and unresolved selections', () => {
	const state = {
		...initialEditorState(true, emptyMonitorLayout()),
		monitor: {
			root: container('root', 'col', [
				leaf(createWidget('clock', 'clock')),
				leaf(group('inline', { w: 40, h: 40 }, container('child', 'col', []))),
				leaf(
					group('missing-def', { w: 40, h: 40 }, container('child2', 'col', []), { def: 'missing' })
				)
			]),
			floating: []
		}
	};
	for (const id of ['none', 'root', 'clock', 'inline', 'missing-def'])
		expect(makeIndependentCopy(state, id, 'new')).toEqual({});
});

it('saves an inline composite as a reusable widget while preserving its placement', () => {
	const inline = group(
		'panel',
		{ w: 120, h: 60 },
		container('child', 'col', [leaf(createWidget('clock', 'inner'))]),
		{ name: 'Desk clock', config: { x: 20, y: 40 }, css: 'color: cyan' }
	);
	const state = {
		...initialEditorState(true, emptyMonitorLayout()),
		monitor: { root: container('root', 'col', []), floating: [leaf(inline)] }
	};
	const patch = makeWidget(state, inline.id);
	expect(patch.library?.defs[0]).toMatchObject({
		name: 'Desk clock',
		size: inline.size,
		child: inline.child,
		css: inline.css
	});
	expect(patch.monitor?.floating[0]).toMatchObject({
		id: inline.id,
		unit: { name: inline.name, config: inline.config, def: patch.library?.defs[0].id }
	});
	expect(state.monitor.floating[0].unit).toEqual(inline);
});

it('ignores a missing reference in an existing library and saves inline flow panels with a friendly default name', () => {
	const child = container('child', 'col', []);
	const panel = group('panel', { w: 100, h: 40 }, child, { def: 'missing' });
	const state = {
		...initialEditorState(true, emptyMonitorLayout()),
		library: { version: 2, defs: [{ id: 'other', name: 'Other', size: panel.size, child }] },
		monitor: { root: container('root', 'col', [leaf(panel)]), floating: [] }
	};
	expect(makeIndependentCopy(state, panel.id, 'copy')).toEqual({});
	const patch = makeWidget(state, panel.id);
	expect(patch.library?.version).toBe(2);
	expect(patch.library?.defs[1].name).toBe('Custom panel');
	expect(patch.monitor?.root.children[0]).toMatchObject({
		unit: { def: patch.library?.defs[1].id }
	});
	const linked = { ...state, monitor: patch.monitor!, library: patch.library! };
	expect(makeWidget(linked, panel.id)).toEqual({});
});

it('retargets one of several floating panels and promotes one inline panel without disturbing its neighbour', () => {
	const child = leaf(createWidget('clock', 'inner'));
	const panel = group('one', { w: 100, h: 40 }, child);
	const other = leaf(createWidget('clock', 'other'));
	const state = {
		...initialEditorState(true, emptyMonitorLayout()),
		monitor: { root: container('root', 'col', []), floating: [leaf(panel), other] }
	};
	const saved = makeWidget(state, 'one');
	expect(saved.monitor?.floating[1]).toEqual(other);
	const copied = makeIndependentCopy(
		{ ...state, monitor: saved.monitor!, library: saved.library! },
		'one',
		'private'
	);
	expect(copied.monitor?.floating[1]).toEqual(other);
	expect(copied.monitor?.floating[0].unit).toMatchObject({ def: 'private' });
});
