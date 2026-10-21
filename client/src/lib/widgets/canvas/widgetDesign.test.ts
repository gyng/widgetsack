import { expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useEditorModel } from './useEditorModel';
import { applyWidgetDesign } from './widgetDesign';
import { initialEditorState } from '../../core/editorReducer';
import { container, group, leaf, type MonitorLayout } from '../../core/layoutTree';
import { createWidget } from '../../core/widget';

it('applies designs to a placement, a selected container or the whole layout without changing shared definitions', () => {
	const child = leaf(createWidget('aiusage', 'usage'));
	const definition = { id: 'shared', name: 'Usage', size: { w: 265, h: 44 }, child };
	const monitor: MonitorLayout = {
		root: container('root', 'col', [
			container('section', 'row', [leaf(createWidget('clock', 'clock'))]),
			leaf(group('panel', definition.size, child, { def: 'shared' }))
		]),
		floating: [leaf(createWidget('text', 'floating'))]
	};
	const state = {
		...initialEditorState(true, monitor),
		library: { version: 1, defs: [definition] }
	};
	const scoped = applyWidgetDesign(state, ['section'], 'minimal', { '--np-text-body': '20px' });
	expect(scoped.monitor?.root.children[0]).toMatchObject({
		children: [
			{ unit: { tokens: { '--np-text-body': '20px', '--np-presentation-mode': 'minimal' } } }
		]
	});
	expect(scoped.monitor?.root.children[1]).toBe(monitor.root.children[1]);
	expect(scoped.monitor?.floating[0]).toBe(monitor.floating[0]);
	expect(scoped.tokenOverrides).toBeUndefined();
	const all = applyWidgetDesign(state, null, 'detailed', { '--np-design-style': 'soft' });
	expect(all.tokenOverrides).toMatchObject({
		'--np-design-style': 'soft',
		'--np-presentation-mode': 'detailed'
	});
	expect(all.monitor?.root.children[1]).toMatchObject({
		unit: { def: 'shared', config: { presentation: 'detailed' } }
	});
	expect(state.library.defs[0]).toBe(definition);
	expect(applyWidgetDesign(state, ['floating'], 'compact', {}).monitor?.floating[0]).toMatchObject({
		unit: { tokens: { '--np-presentation-mode': 'compact' } }
	});
});
it('routes grouping, independent copy and design choices through one undoable operation each', () => {
	const { result } = renderHook(() => useEditorModel(true, []));
	act(() => result.current.dispatch({ type: 'resetHistory' }));
	act(() => result.current.handleOp({ op: 'addWidget', widgetType: 'clock' }));
	const first = result.current.state.selectedId!;
	act(() => result.current.handleOp({ op: 'addWidget', widgetType: 'clock' }));
	const second = result.current.state.selectedId!;
	act(() =>
		result.current.handleOp(
			{ op: 'saveSelectionWidget', ids: [first, second] },
			{ solved: new Map(), bounds: { x: 0, y: 0, w: 1920, h: 1080 } }
		)
	);
	const groupId = result.current.state.selectedId!;
	expect(result.current.state.library?.defs).toHaveLength(1);
	const before = result.current.state.monitor;
	act(() =>
		result.current.handleOp({
			op: 'applyWidgetDesign',
			ids: [groupId],
			presentation: 'minimal',
			tokens: { '--np-text-body': '20px' }
		})
	);
	expect(result.current.state.monitor.floating[0].unit).toMatchObject({
		config: { presentation: 'minimal' }
	});
	act(() => result.current.dispatch({ type: 'undo' }));
	expect(result.current.state.monitor).toBe(before);
	act(() => result.current.handleOp({ op: 'makeIndependentCopy', id: groupId }));
	expect(result.current.state.library?.defs).toHaveLength(2);
	act(() => result.current.dispatch({ type: 'undo' }));
	expect(result.current.state.library?.defs).toHaveLength(1);
	act(() => result.current.handleOp({ op: 'saveSelectionWidget', ids: ['missing', 'none'] }));
	expect(result.current.state.library?.defs).toHaveLength(1);
});
