import { describe, expect, it } from 'vitest';
import { decodeStudioOps, applyStudioOps } from './studioAssistant';
import { emptyMonitorLayout as emptyMonitor, leaf, group } from './layoutTree';
import { createWidget } from './widget';

describe('studio assistant actions', () => {
	it('moves reusable groups using their floating anchor and keeps their contents intact', () => {
		const monitor = emptyMonitor();
		monitor.root.children = [
			leaf(group('dashboard', { w: 392, h: 600 }, leaf(createWidget('clock', 'inside'))))
		];
		const result = applyStudioOps(
			monitor,
			[{ op: 'moveWidget', id: 'dashboard', rect: { x: 100, y: 150, w: 400, h: 620 } }],
			() => 'unused'
		);
		expect(result.monitor.floating[0].unit).toMatchObject({
			kind: 'group',
			config: { x: 100, y: 150, w: 400, h: 620 },
			child: { id: 'inside' }
		});
		expect(monitor.root.children[0]).not.toHaveProperty('unit.rect');
	});
	it('accepts the action vocabulary and rejects invalid IDs, config, placement, and remote CSS', () => {
		const good = [
			{ op: 'clear' },
			{ op: 'addContainer', kind: 'row' },
			{
				op: 'addWidget',
				widgetType: 'sparkline',
				sensor: 'cpu.total',
				config: { smooth: true },
				parent: 'root'
			},
			{ op: 'removeWidget', id: 'cpu' },
			{ op: 'setConfig', id: 'cpu', config: {} },
			{ op: 'setSensor', id: 'cpu', sensor: 'gpu.util' },
			{ op: 'setStyle', id: 'cpu', css: '' },
			{ op: 'moveWidget', id: 'cpu', rect: { x: -10, y: 0, w: 100, h: 100 } }
		];
		expect(decodeStudioOps(good)).toEqual(good);
		expect(() => decodeStudioOps(Array(33).fill({ op: 'clear' }))).toThrow();
		const invalid = [
			null,
			{ op: 'addContainer', kind: 'invalid' },
			{ op: 'addContainer', kind: ['row'] },
			{ op: 'addContainer', kind: 'col', parent: 1 },
			{ op: 'removeWidget' },
			{ op: 'setConfig' },
			{ op: 'setConfig', id: 'x', config: null },
			{ op: 'setSensor' },
			{ op: 'setSensor', id: 'x', sensor: 1 },
			{ op: 'addWidget', widgetType: 'clock', config: [] },
			{ op: 'addWidget', widgetType: 'clock', parent: 1 },
			{ op: 'addWidget', widgetType: 'clock', sensor: 1 },
			{ op: 'setStyle', id: 'x', css: '}' },
			{ op: 'addWidget', widgetType: 'x'.repeat(8193) },
			{ op: 'setStyle', id: 'x', css: '@import "https://example.com";' },
			{ op: 'setStyle', id: 'x', css: 'x'.repeat(8193) },
			{ op: 'setStyle', id: 'x', css: 1 },
			{ op: 'setStyle', css: '' },
			{ op: 'moveWidget' },
			{ op: 'moveWidget', id: 'x', rect: null },
			...[NaN, 100_001, '1'].map((x) => ({
				op: 'moveWidget',
				id: 'x',
				rect: { x, y: 0, w: 10, h: 10 }
			})),
			...[
				{ w: 0, h: 10 },
				{ w: 10, h: 0 },
				{ w: 10_001, h: 10 },
				{ w: 10, h: 10_001 }
			].map((size) => ({ op: 'moveWidget', id: 'x', rect: { x: 0, y: 0, ...size } }))
		];
		for (const item of invalid) expect(() => decodeStudioOps([item])).toThrow();
	});
	it('updates flow and floating styles, reports missing targets, and clears both layers', () => {
		const monitor = emptyMonitor();
		monitor.root.children = [leaf(createWidget('sparkline', 'flow'))];
		monitor.floating = [
			leaf(createWidget('clock', 'floating-clock')),
			leaf(createWidget('bar', 'floating-bar'))
		];
		const result = applyStudioOps(
			monitor,
			[
				{ op: 'setStyle', id: 'flow', css: 'color: red;' },
				{ op: 'setStyle', id: 'floating-clock', css: 'color: blue;' },
				{ op: 'setStyle', id: 'missing', css: '' },
				{ op: 'moveWidget', id: 'root', rect: { x: 0, y: 0, w: 1, h: 1 } },
				{ op: 'addWidget', widgetType: 'text', parent: 'floating' },
				{ op: 'setSensor', id: 'flow', sensor: 'gpu.util' },
				{ op: 'addContainer', kind: 'col' }
			],
			(type) => `${type}-new`
		);
		expect(result.applied).toBe(5);
		expect(result.errors).toHaveLength(2);
		expect(result.monitor.root.children[0]).toMatchObject({
			unit: { css: 'color: red;', sensor: 'gpu.util' }
		});
		expect(result.monitor.floating[0]).toMatchObject({ unit: { css: 'color: blue;' } });
		expect(applyStudioOps(result.monitor, [{ op: 'clear' }], () => 'unused').monitor).toMatchObject(
			{ root: { children: [] }, floating: [] }
		);
	});
	it('rejects the entire malformed batch before changing the layout', () => {
		for (const ops of [
			null,
			{},
			[{ op: 'shell' }],
			[{ op: 'addWidget' }],
			[{ op: 'moveWidget', id: 'x', rect: { x: 0, y: 0, w: -1, h: 10 } }]
		])
			expect(() => decodeStudioOps(ops)).toThrow();
	});
	it('configures, moves, and removes floating widgets without touching the original snapshot', () => {
		const monitor = emptyMonitor();
		monitor.floating = [leaf(createWidget('sparkline', 'cpu'))];
		const result = applyStudioOps(
			monitor,
			decodeStudioOps([
				{ op: 'setConfig', id: 'cpu', config: { smooth: true } },
				{ op: 'moveWidget', id: 'cpu', rect: { x: 20, y: 30, w: 300, h: 80 } }
			]),
			() => 'unused'
		);
		expect(result.errors).toEqual([]);
		expect(result.monitor.floating[0].unit).toMatchObject({
			config: { smooth: true },
			rect: { x: 20, y: 30, w: 300, h: 80 }
		});
		expect(monitor.floating[0].unit).toMatchObject({ config: { smooth: false } });
		expect(
			applyStudioOps(result.monitor, [{ op: 'removeWidget', id: 'cpu' }], () => 'unused').monitor
				.floating
		).toEqual([]);
	});
	it('inserts a widget, floats it, and applies scoped style as one new snapshot', () => {
		const result = applyStudioOps(
			emptyMonitor(),
			decodeStudioOps([
				{ op: 'addWidget', widgetType: 'clock' },
				{ op: 'moveWidget', id: 'clock-new', rect: { x: 50, y: 60, w: 200, h: 70 } },
				{ op: 'setStyle', id: 'clock-new', css: 'color: #77c4d3;' }
			]),
			(type) => `${type}-new`
		);
		expect(result.applied).toBe(3);
		expect(result.monitor.root.children).toEqual([]);
		expect(result.monitor.floating[0].unit).toMatchObject({ css: 'color: #77c4d3;' });
	});
});
