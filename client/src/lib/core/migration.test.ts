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

// A minimal valid primitive unit (passes isUnit) for node-level parse tests.
const validWidgetNode: WidgetInstance = widget('w1', 0, 0, 10, 10);

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

	it('returns null when an explicit-v1 file fails v1 validation', () => {
		// version === 1 takes the `v1raw = raw` path; the monitor has no widgets[] so parseLayoutV1
		// returns null → parseLayoutAny returns null (the `if (v1 === null)` arm).
		expect(parseLayoutAny({ version: 1, monitors: { default: {} } })).toBeNull();
	});

	it('returns null when a monitor entry is null (the raw === null guard)', () => {
		expect(parseLayoutAny({ version: 2, monitors: { m: null } })).toBeNull();
	});

	it('returns null when floating is present but not an array', () => {
		expect(
			parseLayoutAny({
				version: 2,
				monitors: { m: { root: { id: 'r', kind: 'col', children: [] }, floating: 42 } }
			})
		).toBeNull();
	});

	it('fails the monitor when the container id is not a string', () => {
		expect(
			parseLayoutAny({
				version: 2,
				monitors: { m: { root: { id: 5, kind: 'col', children: [] } } }
			})
		).toBeNull();
	});

	it('defaults floating to [] when the key is absent (not undefined-but-present)', () => {
		const r = parseLayoutAny({
			version: 2,
			monitors: { m: { root: { id: 'r', kind: 'col', children: [] } } }
		});
		expect(r?.monitors.m.floating).toEqual([]);
	});
});

describe('parseLayoutNode (node-level whitelist, exercises parseContainer / parseLeaf)', () => {
	it('returns null for a non-object / null node', () => {
		expect(parseLayoutNode(null)).toBeNull();
		expect(parseLayoutNode(42)).toBeNull();
	});

	it('returns null for an object that is neither a container kind nor a leaf (no "unit")', () => {
		expect(parseLayoutNode({ foo: 'bar' })).toBeNull();
	});

	it('keeps every whitelisted container field when valid', () => {
		const n = parseLayoutNode({
			id: 'c',
			kind: 'row',
			children: [],
			basis: 'auto',
			cols: 3,
			rows: 2,
			gap: 8,
			pad: 4,
			margin: { t: 1, r: 2, b: 3, l: 4 },
			align: 'center',
			justify: 'between',
			bounds: { x: 0, y: 0, w: 100, h: 50 },
			overlap: false
		});
		expect(n).toMatchObject({
			id: 'c',
			kind: 'row',
			basis: 'auto',
			cols: 3,
			rows: 2,
			gap: 8,
			pad: 4,
			margin: { t: 1, r: 2, b: 3, l: 4 },
			align: 'center',
			justify: 'between',
			bounds: { x: 0, y: 0, w: 100, h: 50 },
			overlap: false
		});
	});

	it('drops invalid optional container fields (the implicit-false arms)', () => {
		const n = parseLayoutNode({
			id: 'c',
			kind: 'col',
			children: [],
			basis: 'nonsense',
			cols: 'x',
			rows: null,
			gap: '8',
			pad: { t: 1 }, // missing r/b/l → not a Pad
			margin: 'no',
			align: 'middle', // not a valid Align
			justify: 'evenly', // not a valid Justify
			bounds: { x: 0 }, // not a full Rect
			overlap: 'yes',
			cellW: 'no',
			cellH: null,
			aspect: 'x',
			colFr: [1, 'x'], // not all finite numbers
			rowFr: 'no'
		}) as Record<string, unknown>;
		expect(n).toEqual({ id: 'c', kind: 'col', children: [] });
	});

	it('drops malformed children inside a container (children filter null-drop)', () => {
		const n = parseLayoutNode({
			id: 'c',
			kind: 'col',
			children: [{ id: 'L', unit: validWidgetNode }, { nope: true }, 99]
		}) as { children: unknown[] };
		expect(n.children).toHaveLength(1);
	});

	it('treats a non-array children as empty', () => {
		const n = parseLayoutNode({ id: 'c', kind: 'grid', children: 'oops' }) as {
			children: unknown[];
		};
		expect(n.children).toEqual([]);
	});

	it('falls back to the unit id when the leaf has no string id', () => {
		const n = parseLayoutNode({ unit: validWidgetNode }) as { id: string };
		expect(n.id).toBe('w1'); // taken from unit.id
	});

	it('keeps every whitelisted leaf field when valid', () => {
		const n = parseLayoutNode({
			id: 'lf',
			unit: validWidgetNode,
			basis: { fr: 2 },
			margin: 6,
			pad: { t: 1, r: 1, b: 1, l: 1 },
			halign: 'right',
			valign: 'bottom'
		});
		expect(n).toMatchObject({
			id: 'lf',
			basis: { fr: 2 },
			margin: 6,
			pad: { t: 1, r: 1, b: 1, l: 1 },
			halign: 'right',
			valign: 'bottom'
		});
	});

	it('drops invalid optional leaf fields (the implicit-false arms)', () => {
		const n = parseLayoutNode({
			id: 'lf',
			unit: validWidgetNode,
			basis: 'bad',
			margin: 'no',
			pad: { t: 1 }, // not a full Pad
			halign: 'middle', // not a valid HAlign
			valign: 'center' // not a valid VAlign (center is HAlign, not VAlign)
		}) as Record<string, unknown>;
		expect(n).toEqual({ id: 'lf', unit: validWidgetNode });
	});

	it('rejects a leaf whose unit is not a valid unit', () => {
		expect(parseLayoutNode({ id: 'lf', unit: 42 })).toBeNull();
		expect(parseLayoutNode({ id: 'lf', unit: null })).toBeNull();
	});

	it('accepts a group unit by def id or by inline child, rejects an empty group', () => {
		// def-id group
		expect(
			parseLayoutNode({ id: 'g', unit: { id: 'g', kind: 'group', def: 'lib1' } })
		).not.toBeNull();
		// inline-child group
		expect(
			parseLayoutNode({
				id: 'g',
				unit: { id: 'g', kind: 'group', child: { id: 'c', kind: 'col', children: [] } }
			})
		).not.toBeNull();
		// a group with neither def nor a non-null child is not a valid unit → leaf rejected
		expect(parseLayoutNode({ id: 'g', unit: { id: 'g', kind: 'group', child: null } })).toBeNull();
		expect(parseLayoutNode({ id: 'g', unit: { id: 'g', kind: 'group' } })).toBeNull();
	});

	it('validates each Align / HAlign / VAlign / Justify alternative', () => {
		const withField = (field: string, value: unknown) =>
			parseLayoutNode({ id: 'c', kind: 'row', children: [], [field]: value }) as Record<
				string,
				unknown
			>;
		for (const a of ['start', 'center', 'end', 'stretch'])
			expect(withField('align', a).align).toBe(a);
		for (const j of ['start', 'center', 'end', 'between', 'around'])
			expect(withField('justify', j).justify).toBe(j);
		const leafWith = (field: string, value: unknown) =>
			parseLayoutNode({ id: 'lf', unit: validWidgetNode, [field]: value }) as Record<
				string,
				unknown
			>;
		for (const h of ['left', 'right', 'center', 'fill'])
			expect(leafWith('halign', h).halign).toBe(h);
		for (const v of ['top', 'middle', 'bottom', 'fill'])
			expect(leafWith('valign', v).valign).toBe(v);
	});

	it('accepts every Length form for basis (number | auto | content | {fr}) and rejects others', () => {
		const basisOf = (b: unknown) =>
			(parseLayoutNode({ id: 'c', kind: 'row', children: [], basis: b }) as { basis?: unknown })
				.basis;
		expect(basisOf(120)).toBe(120);
		expect(basisOf('auto')).toBe('auto');
		expect(basisOf('content')).toBe('content');
		expect(basisOf({ fr: 1 })).toEqual({ fr: 1 });
		expect(basisOf({ fr: 'x' })).toBeUndefined(); // {fr} present but not a number
		expect(basisOf(null)).toBeUndefined(); // object branch short-circuits on null
		expect(basisOf('weird')).toBeUndefined();
	});

	it('accepts a numeric pad and a per-side pad, rejects partial / non-object', () => {
		const padOf = (p: unknown) =>
			(parseLayoutNode({ id: 'c', kind: 'row', children: [], pad: p }) as { pad?: unknown }).pad;
		expect(padOf(4)).toBe(4); // number form
		expect(padOf({ t: 1, r: 2, b: 3, l: 4 })).toEqual({ t: 1, r: 2, b: 3, l: 4 }); // per-side
		expect(padOf({ t: 1, r: 2, b: 3 })).toBeUndefined(); // missing l
		expect(padOf(null)).toBeUndefined(); // non-number, null object
		expect(padOf('x')).toBeUndefined(); // non-number, non-object
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
