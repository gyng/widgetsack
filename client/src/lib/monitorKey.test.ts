import { describe, expect, it } from 'vitest';
import { gdiTag, monitorByKey, monitorDeviceKey, type StableIds } from './monitorKey';

// GDI tag → stable identity (what list_display_names' `stable` field gives, keyed the way the
// frontend joins it). Taken from the 2026-09-19 machine.
const stable: StableIds = new Map([
	['DISPLAY1', 'DELD154-UID184579'],
	['DISPLAY2', 'CRXED00-UID184576'],
	['DISPLAY3', 'DEL428B-UID184577']
]);

describe('gdiTag', () => {
	it('strips the GDI prefix to the bare device tag', () => {
		expect(gdiTag('\\\\.\\DISPLAY3')).toBe('DISPLAY3');
		expect(gdiTag(null)).toBe('');
		expect(gdiTag('  ')).toBe('');
	});
});

describe('monitorDeviceKey', () => {
	it('prefers the stable identity when one is known for the GDI tag', () => {
		expect(monitorDeviceKey('\\\\.\\DISPLAY2', 1, stable)).toBe('CRXED00-UID184576');
	});

	it('falls back to the GDI device tag when no stable identity is known', () => {
		expect(monitorDeviceKey('\\\\.\\DISPLAY3', 1)).toBe('DISPLAY3');
		expect(monitorDeviceKey('\\\\.\\DISPLAY9', 1, stable)).toBe('DISPLAY9');
	});

	it('falls back to a position-independent m<i> when the platform gives no name', () => {
		expect(monitorDeviceKey(null, 2)).toBe('m2');
		expect(monitorDeviceKey('', 0, stable)).toBe('m0');
	});
});

describe('monitorByKey', () => {
	const monitors = [
		{ name: '\\\\.\\DISPLAY1' },
		{ name: '\\\\.\\DISPLAY3' },
		{ name: '\\\\.\\DISPLAY2' }
	];

	it('finds the monitor by its stable identity', () => {
		expect(monitorByKey(monitors, 'CRXED00-UID184576', stable)).toBe(monitors[2]);
	});

	it('still resolves a legacy GDI-tag key (an unmigrated layout / old window label)', () => {
		expect(monitorByKey(monitors, 'DISPLAY3', stable)).toBe(monitors[1]);
		expect(monitorByKey(monitors, 'DISPLAY3')).toBe(monitors[1]);
	});

	it('follows the monitor, not the GDI number, when Windows re-numbers displays', () => {
		// The strip monitor was DISPLAY3 yesterday and is DISPLAY2 today (its stable key is the same).
		const yesterday: StableIds = new Map([['DISPLAY3', 'CRXED00-UID184576']]);
		const today: StableIds = new Map([['DISPLAY2', 'CRXED00-UID184576']]);
		const key = monitorDeviceKey('\\\\.\\DISPLAY3', 1, yesterday);
		expect(monitorByKey(monitors, key, today)).toBe(monitors[2]); // DISPLAY2 — the same panel
	});

	it('returns null when no current monitor matches the key', () => {
		expect(monitorByKey(monitors, 'DISPLAY9', stable)).toBeNull();
		expect(monitorByKey(monitors, 'XXX0000-UID1', stable)).toBeNull();
	});

	it('matches the m<i> fallback keys index-aware on platforms with no device names', () => {
		const unnamed = [{ name: null }, { name: null }];
		expect(monitorByKey(unnamed, 'm1')).toBe(unnamed[1]);
		expect(monitorByKey(unnamed, 'm2')).toBeNull();
	});
});
