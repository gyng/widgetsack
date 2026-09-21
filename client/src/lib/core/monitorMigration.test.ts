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
			'0': STRIP,
			DISPLAY2: STRIP,
			'1': ABOVE,
			DISPLAY1: ABOVE
		});
	});

	it('lets a saved overlay window size override a re-numbered GDI tag (the shuffle case)', () => {
		const mapping = legacyKeyMapping(today, hints);
		// 'DISPLAY3' names the primary today, so by name it would be skipped; its window was 2560x720,
		// which only the strip is — so the strip's layout follows the strip.
		expect(mapping.DISPLAY3).toBe(STRIP);
		expect(mapping['2']).toBe(STRIP);
		// A hint-confirmed monitor is claimed exclusively: today's tag for the strip no longer maps
		// there, or an unrelated (empty) 'DISPLAY2' layout could overwrite the strip's on migration.
		expect(mapping.DISPLAY2).toBeUndefined();
		expect(mapping['0']).toBeUndefined();
		// Unaffected monitors keep their by-name mapping.
		expect(mapping.DISPLAY1).toBe(ABOVE);
		expect(mapping['1']).toBe(ABOVE);
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
			'0': 'AAA1111-UID1',
			DISPLAY1: 'AAA1111-UID1',
			'1': 'AAA1111-UID2',
			DISPLAY2: 'AAA1111-UID2'
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
		expect(mapping.DISPLAY9).toBe('AAA1111-UID2');
	});

	it('tolerates the 8 px DPI-hop inflation and a re-arranged position', () => {
		// Saved while inflated (2576x736 at 644,2152) and before the strip moved back under the 4K.
		const mapping = legacyKeyMapping(
			today.map((m) => (m.key === STRIP ? { ...m, x: 652, y: 2160 } : { ...m, x: 0, y: 0 })),
			[{ label: 'overlay-DISPLAY3', width: 2576, height: 736, x: -8, y: 1432 }]
		);
		expect(mapping.DISPLAY3).toBe(STRIP);
	});

	it('never maps onto the primary and never remaps a key that is already stable', () => {
		const mapping = legacyKeyMapping(today, [
			{ label: 'overlay-DISPLAY7', width: 3840, height: 2160 }, // the primary's size
			{ label: `overlay-${STRIP}`, width: 2560, height: 720 } // already a stable key
		]);
		expect(mapping.DISPLAY7).toBeUndefined();
		expect(mapping[STRIP]).toBeUndefined();
	});

	it('leaves a monitor with no stable key on its GDI tag (nothing to migrate to)', () => {
		const bare: MigrationMonitor[] = [
			{ index: 0, key: 'DISPLAY2', tag: 'DISPLAY2', primary: false, w: 2560, h: 720 }
		];
		expect(legacyKeyMapping(bare, [])).toEqual({ '0': 'DISPLAY2' });
	});
});
