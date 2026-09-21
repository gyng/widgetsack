import { describe, expect, it } from 'vitest';
import {
	legacyKeyMapping,
	type MigrationMonitor,
	type WindowGeometryHint
} from './monitorMigration';

// The 2026-09-19 machine. Yesterday the strip was DISPLAY3 and the 4K was DISPLAY1; after the 4K
// came back from another HDMI input Windows re-numbered: 4K = DISPLAY3 (primary), strip = DISPLAY2.
const STRIP = 'CRXED00-UID184576';
const ABOVE = 'DELD154-UID184579';

const today: MigrationMonitor[] = [
	{ index: 0, key: STRIP, tag: 'DISPLAY2', primary: false, w: 2560, h: 720 },
	{ index: 1, key: ABOVE, tag: 'DISPLAY1', primary: false, w: 2560, h: 1440 },
	{ index: 2, key: 'DEL428B-UID184577', tag: 'DISPLAY3', primary: true, w: 3840, h: 2160 }
];

const hints: WindowGeometryHint[] = [
	{ label: 'studio', width: 1767, height: 1016 },
	{ label: 'overlay-2', width: 2560, height: 720 }, // index-era window for the strip
	{ label: 'overlay-DISPLAY3', width: 2560, height: 720 }, // GDI-tag-era window for the strip
	{ label: 'overlay-DISPLAY2', width: 1200, height: 900 }, // never fitted: matches no monitor
	{ label: 'main', width: 3840, height: 2160 }
];

describe('legacyKeyMapping', () => {
	it('maps enumeration indices and GDI tags of non-primary monitors to their stable keys', () => {
		expect(legacyKeyMapping(today, [])).toEqual({
			keys: { '0': STRIP, DISPLAY2: STRIP, '1': ABOVE, DISPLAY1: ABOVE },
			evidence: new Set()
		});
	});

	it('lets a saved overlay window size override a re-numbered GDI tag (the shuffle case)', () => {
		const mapping = legacyKeyMapping(today, hints);
		// 'DISPLAY3' names the primary today, so by name it would be skipped; its window was 2560x720,
		// which only the strip is — so the strip's layout follows the strip.
		expect(mapping.keys.DISPLAY3).toBe(STRIP);
		expect(mapping.keys['2']).toBe(STRIP);
		// Today's names for the strip STILL map there (a layout re-keyed to 'DISPLAY2' after the
		// re-numbering — by hand, or by a save on the renamed monitor — must not be stranded by a
		// stale hint), but only the hint-backed keys are `evidence`: migrateMonitorKeys lets those win
		// when both an evidence key and a by-name key carry a layout for the same monitor.
		expect(mapping.keys.DISPLAY2).toBe(STRIP);
		expect(mapping.keys['0']).toBe(STRIP);
		expect([...mapping.evidence].sort()).toEqual(['2', 'DISPLAY3']);
		// Unaffected monitors keep their by-name mapping.
		expect(mapping.keys.DISPLAY1).toBe(ABOVE);
		expect(mapping.keys['1']).toBe(ABOVE);
	});

	it('the 2026-09-20 upgrade: a layout re-keyed to today’s tag survives a stale hint for the old tag', () => {
		// Live 0.0.51 machine: the strip layout was renamed 'DISPLAY3' → 'DISPLAY2' by hand after the
		// re-numbering, but .window-state.json (last written before it) still says overlay-DISPLAY3
		// sat on the strip. The stale evidence must not drop the by-name route for 'DISPLAY2'.
		const positioned: MigrationMonitor[] = today.map((m) =>
			m.key === STRIP ? { ...m, x: 652, y: 2160 } : m
		);
		const mapping = legacyKeyMapping(positioned, [
			{ label: 'overlay-DISPLAY3', width: 2560, height: 720, x: 652, y: 2160 },
			{ label: 'overlay-DISPLAY2', width: 1200, height: 900, x: 114, y: 114 }
		]);
		expect(mapping.keys.DISPLAY2).toBe(STRIP);
		expect(mapping.keys.DISPLAY3).toBe(STRIP);
		expect(mapping.evidence.has('DISPLAY2')).toBe(false);
	});

	it('a legacy id the evidence pins to one monitor is never re-pointed by today’s name', () => {
		// 'DISPLAY3' is the strip by evidence even though the ABOVE monitor is DISPLAY3 by name today.
		const renamed: MigrationMonitor[] = [
			{ index: 0, key: STRIP, tag: 'DISPLAY1', primary: false, w: 2560, h: 720 },
			{ index: 1, key: ABOVE, tag: 'DISPLAY3', primary: false, w: 2560, h: 1440 },
			{ index: 2, key: 'DEL428B-UID184577', tag: 'DISPLAY2', primary: true, w: 3840, h: 2160 }
		];
		const mapping = legacyKeyMapping(renamed, [
			{ label: 'overlay-DISPLAY3', width: 2560, height: 720 }
		]);
		expect(mapping.keys.DISPLAY3).toBe(STRIP);
		expect(mapping.keys['1']).toBe(ABOVE); // ABOVE keeps its other by-name route
		expect(mapping.keys.DISPLAY1).toBe(STRIP);
	});

	it('ignores a hint whose size matches several monitors or none', () => {
		const twins: MigrationMonitor[] = [
			{ index: 0, key: 'AAA1111-UID1', tag: 'DISPLAY1', primary: false, w: 2560, h: 1440 },
			{ index: 1, key: 'AAA1111-UID2', tag: 'DISPLAY2', primary: false, w: 2560, h: 1440 },
			{ index: 2, key: 'BBB2222-UID3', tag: 'DISPLAY3', primary: true, w: 3840, h: 2160 }
		];
		const mapping = legacyKeyMapping(twins, [
			{ label: 'overlay-DISPLAY3', width: 2560, height: 1440 }, // ambiguous
			{ label: 'overlay-DISPLAY9', width: 1024, height: 768 } // no such monitor
		]);
		expect(mapping).toEqual({
			keys: {
				'0': 'AAA1111-UID1',
				DISPLAY1: 'AAA1111-UID1',
				'1': 'AAA1111-UID2',
				DISPLAY2: 'AAA1111-UID2'
			},
			evidence: new Set()
		});
	});

	it('tells two same-size monitors apart by the saved window position', () => {
		const twins: MigrationMonitor[] = [
			{
				index: 0,
				key: 'AAA1111-UID1',
				tag: 'DISPLAY1',
				primary: false,
				w: 2560,
				h: 1440,
				x: 0,
				y: -1440
			},
			{
				index: 1,
				key: 'AAA1111-UID2',
				tag: 'DISPLAY2',
				primary: false,
				w: 2560,
				h: 1440,
				x: 2560,
				y: 0
			},
			{
				index: 2,
				key: 'BBB2222-UID3',
				tag: 'DISPLAY3',
				primary: true,
				w: 3840,
				h: 2160,
				x: 0,
				y: 0
			}
		];
		const mapping = legacyKeyMapping(twins, [
			{ label: 'overlay-DISPLAY9', width: 2560, height: 1440, x: 2560, y: 0 }
		]);
		expect(mapping.keys.DISPLAY9).toBe('AAA1111-UID2');
		expect(mapping.evidence.has('DISPLAY9')).toBe(true);
	});

	it('tolerates the 8 px DPI-hop inflation and a re-arranged position', () => {
		// Saved while inflated (2576x736 at 644,2152) and before the strip moved back under the 4K.
		const mapping = legacyKeyMapping(
			today.map((m) => (m.key === STRIP ? { ...m, x: 652, y: 2160 } : { ...m, x: 0, y: 0 })),
			[{ label: 'overlay-DISPLAY3', width: 2576, height: 736, x: -8, y: 1432 }]
		);
		expect(mapping.keys.DISPLAY3).toBe(STRIP);
	});

	it('never maps onto the primary and never remaps a key that is already stable', () => {
		const mapping = legacyKeyMapping(today, [
			{ label: 'overlay-DISPLAY7', width: 3840, height: 2160 }, // the primary's size
			{ label: `overlay-${STRIP}`, width: 2560, height: 720 } // already a stable key
		]);
		expect(mapping.keys.DISPLAY7).toBeUndefined();
		expect(mapping.keys[STRIP]).toBeUndefined();
	});

	it('leaves a monitor with no stable key on its GDI tag (nothing to migrate to)', () => {
		const bare: MigrationMonitor[] = [
			{ index: 0, key: 'DISPLAY2', tag: 'DISPLAY2', primary: false, w: 2560, h: 720 }
		];
		expect(legacyKeyMapping(bare, []).keys).toEqual({ '0': 'DISPLAY2' });
	});
});
