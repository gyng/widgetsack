import { describe, expect, it } from 'vitest';
import { container, group, leaf, type Library } from './layoutTree';
import { createWidget } from './widget';
import { groupChartState, setGroupChartsSmooth } from './groupCharts';
const chart = (id: string, smooth: boolean) =>
	leaf({ ...createWidget('sparkline', id), config: { smooth } });
describe('group chart controls', () => {
	it('finds mixed charts, edits inline groups, and leaves other widgets unchanged', () => {
		const clock = leaf(createWidget('clock', 'clock'));
		const unit = group(
			'network',
			{ w: 170, h: 130 },
			container('root', 'col', [chart('up', true), chart('down', false), clock])
		);
		unit.name = 'Network';
		expect(groupChartState(unit)).toEqual({ count: 2, value: 'mixed' });
		const edited = setGroupChartsSmooth(unit, true);
		expect(groupChartState(edited)).toEqual({ count: 2, value: 'on' });
		expect(groupChartState(unit).value).toBe('mixed');
		expect(setGroupChartsSmooth(edited, true)).toBe(edited);
		expect(groupChartState(setGroupChartsSmooth(edited, false)).value).toBe('off');
		const empty = group('clock', { w: 100, h: 100 }, clock);
		expect(groupChartState(empty)).toEqual({ count: 0, value: 'off' });
		expect(setGroupChartsSmooth(empty, true)).toBe(empty);
	});
	it('copies only edited library instances, preserving CSS, size, params and shared definitions', () => {
		const def = {
			id: 'system',
			name: 'System',
			size: { w: 250, h: 150 },
			child: leaf(createWidget('cpu', 'cpu')),
			css: 'color: red;',
			params: [{ key: 'label', default: 'CPU', target: 'unit.config.label' }]
		};
		const library: Library = { version: 1, defs: [{ ...def, id: 'other' }, def] };
		const unit = group('instance', { w: 10, h: 10 }, def.child, {
			def: def.id,
			css: 'opacity: .8;',
			params: { label: 'My CPU' }
		});
		const edited = setGroupChartsSmooth(unit, true, library);
		expect(edited).toMatchObject({
			name: 'System',
			size: def.size,
			css: 'color: red;\nopacity: .8;',
			child: { unit: { config: { smooth: true, label: 'My CPU' } } }
		});
		expect(edited.def).toBeUndefined();
		expect(edited.params).toBeUndefined();
		expect(groupChartState(unit, library).value).toBe('off');
		expect(def.child).toHaveProperty('unit.config.smooth', false);
	});
	it('edits nested groups and stops at cyclic library references', () => {
		const nested = group(
			'outer',
			{ w: 100, h: 100 },
			leaf(group('inner', { w: 100, h: 100 }, chart('cpu', false)))
		);
		expect(groupChartState(setGroupChartsSmooth(nested, true)).value).toBe('on');
		const cycle = group('cycle', { w: 100, h: 100 }, container('empty', 'col', []), {
			def: 'cycle'
		});
		const library: Library = {
			version: 1,
			defs: [{ id: 'cycle', name: 'cycle', size: cycle.size, child: leaf(cycle) }]
		};
		expect(groupChartState(cycle, library).count).toBe(0);
	});
});

it('recognizes Sensor History and leaves unknown widget types intact', () => {
	const history = group('history', { w: 360, h: 150 }, leaf(createWidget('history', 'history')));
	expect(groupChartState(setGroupChartsSmooth(history, true)).value).toBe('on');
	const unknown = group(
		'external',
		{ w: 100, h: 100 },
		leaf({
			id: 'external',
			type: 'unregistered',
			rect: { x: 0, y: 0, w: 100, h: 100 },
			config: { smooth: true }
		})
	);
	expect(setGroupChartsSmooth(unknown, false)).toBe(unknown);
});
