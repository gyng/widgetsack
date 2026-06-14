import { describe, expect, it } from 'vitest';
import type { Layout as LayoutV1, WidgetInstance } from './layout';
import { emptyRoot, type MonitorLayout } from './layoutTree';
import { migrateMonitorKeys, migrateV1, parseLayoutAny, parseLayoutNode } from './migration';

describe('migrateMonitorKeys', () => {
	const mon = (): MonitorLayout => ({ root: emptyRoot(), floating: [] });

	it('remaps legacy numeric keys via the mapping, leaving default untouched', () => {
		const out = migrateMonitorKeys(
			{ default: mon(), '1': mon(), '2': mon() },
			{ '1': 'DISPLAY3', '2': 'DISPLAY2' }
		);
		expect(out && Object.keys(out).sort()).toEqual(['DISPLAY2', 'DISPLAY3', 'default']);
	});

	it('returns null when nothing needs remapping (already device-keyed)', () => {
		expect(migrateMonitorKeys({ default: mon(), DISPLAY3: mon() }, { '1': 'DISPLAY3' })).toBeNull();
	});

	it('keeps a numeric key with no current monitor so its layout is not orphaned', () => {
		const out = migrateMonitorKeys({ '1': mon(), '5': mon() }, { '1': 'DISPLAY2' });
		expect(out && Object.keys(out).sort()).toEqual(['5', 'DISPLAY2']);
	});

	it('never clobbers an existing device-keyed entry with a remapped legacy one', () => {
		const keep = mon();
		const legacy = mon();
		const out = migrateMonitorKeys({ DISPLAY2: keep, '1': legacy }, { '1': 'DISPLAY2' });
		expect(out).toBeNull(); // legacy '1' stays put rather than overwriting DISPLAY2
	});
});

const widget = (id: string, x: number, y: number, w: number, h: number): WidgetInstance => ({
	id,
	type: 'gauge',
	rect: { x, y, w, h },
	config: {}
});

describe('migrateV1', () => {
	it('wraps every widget as a floating leaf under an empty root, rects verbatim', () => {
		const v1: LayoutV1 = {
			version: 1,
			monitors: {
				default: { widgets: [widget('g', 10, 10, 100, 100), widget('clk', 200, 10, 160, 40)] }
			}
		};
		const v2 = migrateV1(v1);
		expect(v2.version).toBe(2);
		// The canonical empty root (incl. its creation-time pad — harmless here: v1 widgets are
		// all floating with verbatim rects, so an empty padded root renders nothing differently).
		expect(v2.monitors.default.root).toEqual(emptyRoot());
		expect(v2.monitors.default.floating).toHaveLength(2);
		expect(v2.monitors.default.floating[0]).toEqual({
			id: 'g',
			unit: widget('g', 10, 10, 100, 100)
		});
		expect((v2.monitors.default.floating[1].unit as WidgetInstance).rect).toEqual({
			x: 200,
			y: 10,
			w: 160,
			h: 40
		});
	});

	it('drops a v1 widget whose rect is not a full numeric rect', () => {
		const v1 = {
			version: 1,
			monitors: { default: { widgets: [{ id: 'w', type: 'gauge', rect: {}, config: {} }] } }
		} as unknown as LayoutV1;
		expect(migrateV1(v1).monitors.default.floating).toHaveLength(0);
	});
});

describe('parseLayoutAny', () => {
	const validWidget = widget('w1', 0, 0, 10, 10);

	it('migrates a v1 layout to v2 floating', () => {
		const r = parseLayoutAny({ version: 1, monitors: { default: { widgets: [validWidget] } } });
		expect(r?.version).toBe(2);
		expect(r?.monitors.default.root.children).toHaveLength(0);
		expect(r?.monitors.default.floating).toHaveLength(1);
		expect(r?.monitors.default.floating[0].unit.id).toBe('w1');
	});

	it('passes a valid v2 layout through (root tree + floating)', () => {
		const r = parseLayoutAny({
			version: 2,
			monitors: {
				default: {
					root: { id: 'r', kind: 'row', children: [{ id: 'L', unit: validWidget }] },
					floating: [{ id: 'F', unit: widget('w2', 5, 5, 20, 20) }]
				}
			}
		});
		expect(r?.version).toBe(2);
		expect(r?.monitors.default.root.children).toHaveLength(1);
		expect(r?.monitors.default.floating).toHaveLength(1);
	});

	it('treats a versionless legacy file as v1', () => {
		const r = parseLayoutAny({ monitors: { default: { widgets: [validWidget] } } });
		expect(r).not.toBeNull();
		expect(r?.version).toBe(2);
		expect(r?.monitors.default.floating).toHaveLength(1);
	});

	it('drops malformed v2 floating leaves but keeps valid ones', () => {
		const r = parseLayoutAny({
			version: 2,
			monitors: {
				default: {
					root: { id: 'r', kind: 'col', children: [] },
					floating: [{ id: 'F', unit: validWidget }, { id: 'bad' }, 42]
				}
			}
		});
		expect(r?.monitors.default.floating).toHaveLength(1);
	});

	it('tolerates a missing v2 root by substituting an empty root', () => {
		const r = parseLayoutAny({ version: 2, monitors: { m: { floating: [] } } });
		expect(r).not.toBeNull();
		expect(r?.monitors.m.root).toEqual(emptyRoot());
	});

	it('preserves a valid per-monitor background and drops a malformed one', () => {
		const r = parseLayoutAny({
			version: 2,
			monitors: {
				a: {
					floating: [],
					background: { kind: 'video', src: 'loop.mp4', fit: 'cover', opacity: 1 }
				},
				b: { floating: [], background: { kind: 'nope' } }
			}
		});
		expect(r?.monitors.a.background).toEqual({
			kind: 'video',
			src: 'loop.mp4',
			fit: 'cover',
			opacity: 1
		});
		expect(r?.monitors.b.background).toBeUndefined();
	});

	it('keeps a per-monitor theme string (incl. explicit "") and drops a non-string', () => {
		const r = parseLayoutAny({
			version: 2,
			monitors: {
				a: { floating: [], theme: 'builtin:nord' }, // a real override
				b: { floating: [], theme: '' }, // explicit default (distinct from absent)
				c: { floating: [] }, // no override → undefined (inherits the global)
				d: { floating: [], theme: 42 } // malformed → dropped to undefined
			}
		});
		expect(r?.monitors.a.theme).toBe('builtin:nord');
		expect(r?.monitors.b.theme).toBe('');
		expect(r?.monitors.c.theme).toBeUndefined();
		expect(r?.monitors.d.theme).toBeUndefined();
	});

	it('round-trips a container condition (appOpen + sensor) and drops a malformed one', () => {
		const r = parseLayoutAny({
			version: 2,
			monitors: {
				m: {
					root: {
						id: 'r',
						kind: 'col',
						children: [
							{
								id: 'a',
								kind: 'row',
								children: [],
								condition: { kind: 'appOpen', matchExe: 'spotify.exe' }
							},
							{
								id: 'b',
								kind: 'row',
								children: [],
								condition: { kind: 'sensor', sensorId: 'cpu.total', op: '>', value: '80' }
							},
							{ id: 'c', kind: 'row', children: [], condition: { kind: 'nope' } }
						]
					},
					floating: []
				}
			}
		});
		const kids = r?.monitors.m.root.children as { id: string; condition?: unknown }[];
		expect(kids[0].condition).toEqual({ kind: 'appOpen', matchExe: 'spotify.exe' });
		expect(kids[1].condition).toEqual({
			kind: 'sensor',
			sensorId: 'cpu.total',
			op: '>',
			value: '80'
		});
		expect(kids[2].condition).toBeUndefined(); // malformed → dropped, container still kept
	});

	it('persists previously-dropped grid/overlap container fields across reload', () => {
		const grid = {
			id: 'g',
			kind: 'grid',
			cols: 2,
			rows: 2,
			overlap: true,
			cellW: 120,
			cellH: 80,
			aspect: 1.5,
			colFr: [1, 2],
			rowFr: [3, 1],
			children: []
		};
		const r = parseLayoutAny({ version: 2, monitors: { m: { root: grid, floating: [] } } });
		expect(r?.monitors.m.root).toMatchObject({
			rows: 2,
			overlap: true,
			cellW: 120,
			cellH: 80,
			aspect: 1.5,
			colFr: [1, 2],
			rowFr: [3, 1]
		});
	});

	it('returns null on unrecoverable structural failure', () => {
		expect(parseLayoutAny(null)).toBeNull();
		expect(parseLayoutAny('nope')).toBeNull();
		expect(parseLayoutAny({ version: 2 })).toBeNull(); // no monitors
		expect(
			parseLayoutAny({
				version: 2,
				monitors: { m: { root: { id: 'r', kind: 'bogus', children: [] } } }
			})
		).toBeNull(); // bad container kind fails the monitor
		expect(parseLayoutAny({ version: 3, monitors: {} })).toBeNull(); // unknown future version
	});

	it('rejects an array for monitors (must be a Record)', () => {
		expect(parseLayoutAny({ version: 2, monitors: [] })).toBeNull();
		expect(
			parseLayoutAny({ version: 2, monitors: [{ root: { id: 'r', kind: 'col', children: [] } }] })
		).toBeNull();
	});

	it('returns null for a stringy version (hand-edited legacy file)', () => {
		expect(
			parseLayoutAny({ version: '1', monitors: { default: { widgets: [validWidget] } } })
		).toBeNull();
	});
});

describe("parseLayoutNode preserves a 'content' (hug) basis", () => {
	// Regression: isLength dropped 'content', so a hugged widget/group rendered fine in the studio
	// (in-memory) but clipped on the overlay (re-parsed from disk with the basis gone).
	const basisOf = (n: unknown) => (n as { basis?: unknown } | null)?.basis;

	it('on a primitive leaf', () => {
		const n = parseLayoutNode({
			id: 't',
			unit: { id: 't', type: 'text', rect: { x: 0, y: 0, w: 10, h: 10 }, config: {} },
			basis: 'content'
		});
		expect(basisOf(n)).toBe('content');
	});

	it('on a GROUP leaf (the Network widget)', () => {
		const n = parseLayoutNode({
			id: 'g',
			unit: {
				id: 'g',
				kind: 'group',
				size: { w: 170, h: 104 },
				child: { id: 'c', kind: 'col', children: [] }
			},
			basis: 'content'
		});
		expect(basisOf(n)).toBe('content');
	});

	it('on a container', () => {
		expect(basisOf(parseLayoutNode({ id: 'r', kind: 'row', children: [], basis: 'content' }))).toBe(
			'content'
		);
	});
});
