import { describe, it, expect } from 'vitest';
import { buildDebugInfo, type DebugArgs } from './debugInfo';
import { container, group, leaf, type MonitorLayout } from '../../core/layoutTree';
import { createWidget } from '../../core/widget';
import type { Solved } from '../../core/solve';

describe('buildDebugInfo', () => {
	function clockDef(pad: number): MonitorLayout {
		const root = container(
			'root',
			'col',
			[
				container('cell-a', 'col', [], { align: 'stretch', basis: { fr: 1 } }),
				container('cell-b', 'col', [], { align: 'stretch', basis: { fr: 1 } })
			],
			{ pad, gap: 15, align: 'stretch', basis: { fr: 1 } }
		);
		return { root, floating: [] };
	}

	// Hand-built measured boxes for the clockDef tree over a 166×98 canvas (replaces the old
	// solveMonitor call): pad 111 collapses the content to zero so both fr cells are zero-size;
	// pad 8 leaves a 150×82 content that the two fr:1 cells split (minus the 15px gap) ~33.5 high.
	function solvedFor(pad: number): Solved {
		if (pad === 111) {
			return new Map([
				['root', { x: 0, y: 0, w: 166, h: 98 }],
				['cell-a', { x: 111, y: 98, w: 0, h: 0 }],
				['cell-b', { x: 111, y: 98, w: 0, h: 0 }]
			]);
		}
		return new Map([
			['root', { x: 0, y: 0, w: 166, h: 98 }],
			['cell-a', { x: 8, y: 8, w: 150, h: 33.5 }],
			['cell-b', { x: 8, y: 56.5, w: 150, h: 33.5 }]
		]);
	}

	const argsFor = (mon: MonitorLayout, pad: number, workArea = { x: 0, y: 0, w: 166, h: 98 }) => ({
		designing: true,
		editingDef: { id: 'def-clock', name: 'Clock (JP weekday)', size: { w: 166, h: 98 } },
		monitorKey: 'default',
		workArea,
		stageSize: { w: 166, h: 98 },
		zoom: 2.73,
		panX: 10,
		panY: 20,
		monitor: mon,
		solved: solvedFor(pad),
		selectedId: 'cell-b',
		defs: [{ id: 'def-clock', name: 'Clock (JP weekday)', size: { w: 166, h: 98 } }]
	});

	it('flags collapsed (zero-size) panes from an over-padded canvas', () => {
		const out = buildDebugInfo(argsFor(clockDef(111), 111));
		expect(out).toContain('COLLAPSED');
		expect(out).toMatch(/issues \(2\)/); // both cells collapsed
		expect(out).toContain('"pad": 111'); // the over-large pad is captured in the tree dump
		expect(out).toContain('editing def: def-clock');
	});

	it('reports no issues for a sane pad where the cells fill the canvas', () => {
		const out = buildDebugInfo(argsFor(clockDef(8), 8));
		expect(out).toContain('issues: none detected');
		expect(out).not.toContain('COLLAPSED');
	});

	// A monitor whose root holds a single placed leaf (widget instance or group). Used to drive the
	// `isLeaf(sel)` summary branch — the existing tests only ever select a container.
	function withLeaf(leafNode: ReturnType<typeof leaf>): MonitorLayout {
		return { root: container('root', 'col', [leafNode], { pad: 8 }), floating: [] };
	}

	const leafArgs = (mon: MonitorLayout, selectedId: string | null): DebugArgs => ({
		designing: false,
		editingDef: null,
		monitorKey: 'default',
		workArea: { x: 0, y: 0, w: 200, h: 100 },
		stageSize: { w: 200, h: 100 },
		zoom: 1,
		panX: 0,
		panY: 0,
		monitor: mon,
		solved: new Map([
			['root', { x: 0, y: 0, w: 200, h: 100 }],
			['w1', { x: 8, y: 8, w: 184, h: 84 }]
		]),
		selectedId,
		defs: []
	});

	it('summarises a selected widget-instance leaf by its type and box', () => {
		const w = createWidget('gauge', 'w1');
		const out = buildDebugInfo(leafArgs(withLeaf(leaf(w)), 'w1'));
		expect(out).toContain('selected: w1 (gauge) box {x:8, y:8, w:184, h:84}');
		expect(out).toContain('mode: layout');
		expect(out).toContain('floating widgets: 0');
		expect(out).not.toContain('editing def:');
		expect(out).not.toContain('library defs:');
	});

	it('summarises a selected group leaf that references a library def', () => {
		const g = group('w1', { w: 80, h: 40 }, leaf(createWidget('clock', 'inner')), { def: 'def-x' });
		const out = buildDebugInfo(leafArgs(withLeaf(leaf(g)), 'w1'));
		expect(out).toContain('selected: w1 (group:def-x) box');
	});

	it('summarises an inline group leaf (no def) as group:inline', () => {
		const g = group('w1', { w: 80, h: 40 }, leaf(createWidget('clock', 'inner')));
		const out = buildDebugInfo(leafArgs(withLeaf(leaf(g)), 'w1'));
		expect(out).toContain('selected: w1 (group:inline) box');
	});

	it('finds a selected leaf in the floating layer (not just the flow tree)', () => {
		const w = createWidget('text', 'w1');
		const mon: MonitorLayout = {
			root: container('root', 'col', [], { pad: 8 }),
			floating: [leaf(w)]
		};
		const out = buildDebugInfo(leafArgs(mon, 'w1'));
		expect(out).toContain('selected: w1 (text)');
		expect(out).toContain('floating widgets: 1');
	});

	it('reports "(none)" when nothing is selected', () => {
		const out = buildDebugInfo(leafArgs(withLeaf(leaf(createWidget('gauge', 'w1'))), null));
		expect(out).toContain('selected: (none)');
	});

	it('reports "(none)" when the selected id matches no node anywhere', () => {
		// findNode → null AND floating.find → null exercises the final `?? null` fallback.
		const out = buildDebugInfo(leafArgs(withLeaf(leaf(createWidget('gauge', 'w1'))), 'ghost'));
		expect(out).toContain('selected: (none)');
	});

	it('renders an em dash for a selected node with no solved box (container + leaf)', () => {
		// A container with no `basis`/`pad`/`gap` exercises the padGap fallbacks; an empty `solved`
		// map exercises the `box ? … : '—'` else-arms for both the container and the leaf branches.
		const cont: MonitorLayout = { root: container('root', 'col', []), floating: [] };
		const cOut = buildDebugInfo({
			...leafArgs(cont, 'root'),
			solved: new Map() as Solved
		});
		expect(cOut).toContain('selected: root (col) box —');
		expect(cOut).toContain('basis="auto"'); // c.basis ?? 'auto' fallback

		const leafMon = withLeaf(leaf(createWidget('gauge', 'w1')));
		const lOut = buildDebugInfo({
			...leafArgs(leafMon, 'w1'),
			solved: new Map() as Solved
		});
		expect(lOut).toContain('selected: w1 (gauge) box —');
	});

	it('flags an out-of-bounds (but non-collapsed) container', () => {
		const mon: MonitorLayout = {
			root: container('root', 'col', [container('cell', 'col', [], { basis: { fr: 1 } })], {
				pad: 8
			}),
			floating: []
		};
		const solved: Solved = new Map([
			['root', { x: 0, y: 0, w: 200, h: 100 }],
			// extends past the 200×100 work area on the right/bottom — escapes, but has real size
			['cell', { x: 150, y: 80, w: 100, h: 60 }]
		]);
		const out = buildDebugInfo({ ...leafArgs(mon, null), solved });
		expect(out).toContain('OUT-OF-BOUNDS');
		expect(out).not.toContain('COLLAPSED');
	});
});
