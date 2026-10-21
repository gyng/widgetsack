import { expect, it } from 'vitest';
import { container, leaf, group, type MonitorLayout } from './layoutTree';
import { createWidget } from './widget';
import { selectionBreadcrumb } from './widgetContext';

it('names the selected widget and its containers without exposing ids', () => {
	const monitor: MonitorLayout = {
		root: container('root', 'col', [
			container('row', 'row', [leaf(createWidget('clock', 'clock-1'))])
		]),
		floating: []
	};
	expect(selectionBreadcrumb(monitor, 'clock-1')).toEqual([
		{ id: 'row', label: 'Row' },
		{ id: 'clock-1', label: 'Clock' }
	]);
	expect(selectionBreadcrumb(monitor, 'row')).toEqual([{ id: 'row', label: 'Row' }]);
	expect(selectionBreadcrumb(monitor, 'root')).toEqual([{ id: 'root', label: 'Layout' }]);
	expect(selectionBreadcrumb(monitor, 'missing')).toEqual([]);
	expect(selectionBreadcrumb(monitor, null)).toEqual([]);
});
it('labels floating reusable groups and unknown widget types without entering their internals', () => {
	const monitor: MonitorLayout = {
		root: container('root', 'grid', []),
		floating: [
			leaf(
				group('panel', { w: 100, h: 50 }, leaf(createWidget('clock', 'inside')), {
					name: 'Desk clock'
				})
			),
			leaf(createWidget('unregistered', 'other'))
		]
	};
	expect(selectionBreadcrumb(monitor, 'panel')).toEqual([{ id: 'panel', label: 'Desk clock' }]);
	expect(selectionBreadcrumb(monitor, 'inside')).toEqual([]);
	expect(selectionBreadcrumb(monitor, 'other')).toEqual([{ id: 'other', label: 'unregistered' }]);
	monitor.floating[0].unit = group('panel', { w: 100, h: 50 }, container('inside', 'col', []));
	expect(selectionBreadcrumb(monitor, 'panel')).toEqual([{ id: 'panel', label: 'Widget' }]);
});
