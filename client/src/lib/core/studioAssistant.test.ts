import type { Leaf } from './layoutTree';
import { describe, expect, it } from 'vitest';
import { decodeStudioOps, applyStudioOps } from './studioAssistant';
import { emptyMonitorLayout as emptyMonitor, leaf, group, container } from './layoutTree';
import { createWidget } from './widget';

describe('studio assistant actions', () => {
	it('validates and applies scoped design presets while preserving manual overrides and sibling widgets', () => {
		const op = { op: 'applyDesignPreset', id: 'clock', style: 'soft', density: 'large' } as const;
		expect(decodeStudioOps([op, { ...op, replace: true }])).toEqual([op, { ...op, replace: true }]);
		for (const patch of [{ id: '' }, { style: 'bad' }, { density: 'bad' }, { replace: 'yes' }])
			expect(() => decodeStudioOps([{ ...op, ...patch }])).toThrow();
		const monitor = emptyMonitor();
		const clock = createWidget('clock', 'clock');
		clock.tokens = { '--np-text-body': '22px' };
		monitor.root.children = [
			leaf(clock),
			leaf(group('cluster', { w: 100, h: 100 }, leaf(createWidget('text', 'inside'))))
		];
		monitor.floating = [leaf(createWidget('text', 'floating'))];
		const result = applyStudioOps(
			monitor,
			[
				op,
				{ ...op, id: 'cluster', replace: false },
				{ ...op, id: 'cluster/inside' },
				{ ...op, id: 'floating' }
			],
			() => 'unused'
		);
		expect(result.applied).toBe(4);
		expect((result.monitor.root.children[0] as Leaf).unit.tokens).toMatchObject({
			'--np-text-body': '22px',
			'--np-radius': '12px'
		});
		expect(result.monitor.floating[0].unit.tokens).toMatchObject({ '--np-text-body': '20px' });
		expect(monitor.floating[0].unit.tokens).toBeUndefined();
		expect(applyStudioOps(monitor, [{ ...op, id: 'root' }], () => 'unused').errors).toHaveLength(1);
	});
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

it('edits grouped widgets by rendered ID without changing a shared definition or sibling', () => {
	const child = container('inner', 'col', [leaf(createWidget('cpu', 'cores'))]);
	const def = {
		id: 'system',
		name: 'System',
		size: { w: 200, h: 100 },
		child,
		css: 'color: lime;'
	};
	const library = { version: 1, defs: [def] };
	const one = group('one', def.size, child, {
		def: def.id,
		params: { mode: 'cores' },
		css: 'padding: 2px;'
	});
	const two = group('two', def.size, child, { def: def.id });
	const source = { root: container('root', 'col', [leaf(one)]), floating: [leaf(two)] };
	const result = applyStudioOps(
		source,
		decodeStudioOps([
			{ op: 'setConfig', id: 'one/cores', config: { smooth: true } },
			{ op: 'setLayout', id: 'one/inner', gap: 12 },
			{ op: 'setStyle', id: 'two/cores', css: 'opacity: .8;' },
			{ op: 'setSensor', id: 'two/cores', sensor: 'cpu.total' }
		]),
		() => 'unused',
		library
	);
	expect(result.applied).toBe(4);
	expect(result.errors).toEqual([]);
	const first = result.monitor.root.children[0] as Leaf;
	expect(first.unit).not.toHaveProperty('def');
	expect(first.unit.css).toBe('color: lime;\npadding: 2px;');
	expect(def.child.children[0]).toHaveProperty('unit.config.smooth', false);
	expect(source.root.children[0]).toEqual(leaf(one));
});
it('supports container spacing and rejects invalid spacing or unsupported nested actions without data loss', () => {
	expect(() => decodeStudioOps([{ op: 'setLayout', id: 'root', gap: -1 }])).toThrow();
	expect(() => decodeStudioOps([{ op: 'setLayout', id: 'root', gap: 1001 }])).toThrow();
	expect(() => decodeStudioOps([{ op: 'setLayout', id: 'root', gap: NaN }])).toThrow();
	const child = container('inner', 'col', [leaf(createWidget('clock', 'clock'))]);
	const source = {
		root: container('root', 'col', [leaf(group('g', { w: 100, h: 100 }, child))]),
		floating: []
	};
	const result = applyStudioOps(
		source,
		[
			{ op: 'setLayout', id: 'root', gap: 8 },
			{ op: 'setLayout', id: 'g/missing', gap: 8 },
			{ op: 'setLayout', id: 'g/clock', gap: 8 },
			{ op: 'moveWidget', id: 'g/clock', rect: { x: 0, y: 0, w: 100, h: 100 } },
			{ op: 'setStyle', id: 'g/inner', css: '' }
		],
		() => 'unused'
	);
	expect(result.applied).toBe(1);
	expect(result.errors).toHaveLength(4);
	expect(result.monitor.root.gap).toBe(8);
	expect(result.monitor.root.children[0]).toEqual(source.root.children[0]);
});

it('rejects setStyle CSS that reaches outside the app however it is spelled', () => {
	for (const css of [
		String.raw`background: \75rl(https://x.example/p.png);`,
		'background: image-set("https://x.example/p.png" 1x);',
		'position: fixed; inset: 0;',
		String.raw`@imp\6frt "https://x.example/a.css";`,
		'background: url(//x.example/p.png);'
	])
		expect(() => decodeStudioOps([{ op: 'setStyle', id: 'x', css }])).toThrow();
	const local = 'background: url(data:image/png;base64,AA); color: red; position: relative;';
	expect(decodeStudioOps([{ op: 'setStyle', id: 'x', css: local }])).toEqual([
		{ op: 'setStyle', id: 'x', css: local }
	]);
});

it('refuses remote capability config on grouped widgets without detaching the instance', () => {
	const monitor = emptyMonitor();
	monitor.root.children = [
		leaf(group('g', { w: 100, h: 100 }, leaf(createWidget('image', 'pic'))))
	];
	const result = applyStudioOps(
		monitor,
		[{ op: 'setConfig', id: 'g/pic', config: { src: 'https://x.example/p.png' } }],
		() => 'unused'
	);
	expect(result.applied).toBe(0);
	expect(result.errors).toHaveLength(1);
	expect(result.errors[0]).toMatch(/remote-image/);
	expect(result.monitor.root.children[0]).toMatchObject({
		unit: { child: { unit: { config: { src: '' } } } }
	});
});
