import { describe, expect, it } from 'vitest';
import {
	buildSourceSpec,
	formatStats,
	inputName,
	monitorInputRows,
	parseSourceSpec,
	sourceEditorRows
} from './monitorInputs';

describe('inputName', () => {
	it('names standard MCCS codes', () => {
		expect(inputName(0x0f)).toBe('DisplayPort 1');
		expect(inputName(0x11)).toBe('HDMI 1');
		expect(inputName(0x12)).toBe('HDMI 2');
	});

	it('falls back to a padded hex label for unknown codes', () => {
		expect(inputName(0x1b)).toBe('Input 0x1B');
		expect(inputName(0x03)).toBe('DVI 1');
	});
});

describe('parseSourceSpec', () => {
	it('returns [] for blank/undefined', () => {
		expect(parseSourceSpec(undefined)).toEqual([]);
		expect(parseSourceSpec('')).toEqual([]);
		expect(parseSourceSpec('   ')).toEqual([]);
	});

	it('parses decimal, 0x-hex and trailing-h codes', () => {
		expect(parseSourceSpec('17, 0x0f, 12h')).toEqual([
			{ value: 17, label: inputName(17) },
			{ value: 0x0f, label: 'DisplayPort 1' },
			{ value: 0x12, label: 'HDMI 2' }
		]);
	});

	it('honours explicit labels and preserves order', () => {
		expect(parseSourceSpec('0x11=Desktop, 0x12=Console')).toEqual([
			{ value: 0x11, label: 'Desktop' },
			{ value: 0x12, label: 'Console' }
		]);
	});

	it('accepts newline separators and trims whitespace', () => {
		expect(parseSourceSpec(' 0x0f = DP \n 0x11 = HDMI ')).toEqual([
			{ value: 0x0f, label: 'DP' },
			{ value: 0x11, label: 'HDMI' }
		]);
	});

	it('drops junk and out-of-range codes', () => {
		expect(parseSourceSpec('zzz, 999, -1, 0x11=ok')).toEqual([{ value: 0x11, label: 'ok' }]);
	});
});

describe('monitorInputRows', () => {
	it('uses discovered inputs when no spec, marking the active one', () => {
		const rows = monitorInputRows({ discovered: [0x0f, 0x11, 0x12], current: 0x11 });
		expect(rows).toEqual([
			{ value: 0x0f, label: 'DisplayPort 1', active: false },
			{ value: 0x11, label: 'HDMI 1', active: true },
			{ value: 0x12, label: 'HDMI 2', active: false }
		]);
	});

	it('prefers the spec over discovered inputs (filter + order + rename)', () => {
		const rows = monitorInputRows({
			discovered: [0x0f, 0x10, 0x11, 0x12],
			spec: '0x12=Console, 0x0f=PC',
			current: 0x0f
		});
		expect(rows).toEqual([
			{ value: 0x12, label: 'Console', active: false },
			{ value: 0x0f, label: 'PC', active: true }
		]);
	});

	it('falls back to defaults when nothing is discovered or specced', () => {
		const rows = monitorInputRows({ discovered: [], current: null });
		expect(rows.map((r) => r.value)).toEqual([0x0f, 0x10, 0x11, 0x12]);
		expect(rows.every((r) => !r.active)).toBe(true);
	});

	it('always includes the active input even if outside the chosen set', () => {
		const rows = monitorInputRows({ discovered: [], spec: '0x11', current: 0x1b });
		expect(rows).toEqual([
			{ value: 0x11, label: 'HDMI 1', active: false },
			{ value: 0x1b, label: 'Input 0x1B', active: true }
		]);
	});

	it('de-duplicates repeated values, keeping the first label', () => {
		const rows = monitorInputRows({ discovered: [], spec: '0x11=One, 0x11=Two', current: null });
		expect(rows).toEqual([{ value: 0x11, label: 'One', active: false }]);
	});
});

describe('formatStats', () => {
	it('formats resolution + refresh', () => {
		expect(formatStats({ width: 2560, height: 1440, refreshHz: 144 })).toBe('2560×1440 · 144 Hz');
	});

	it('drops the refresh when unknown', () => {
		expect(formatStats({ width: 1920, height: 1080, refreshHz: 0 })).toBe('1920×1080');
	});

	it('is empty when the mode is unknown', () => {
		expect(formatStats(null)).toBe('');
		expect(formatStats({ width: 0, height: 0, refreshHz: 0 })).toBe('');
	});
});

describe('sourceEditorRows', () => {
	it('lists all detected inputs as included with default names when the spec is blank', () => {
		expect(sourceEditorRows([0x0f, 0x11], '')).toEqual([
			{ value: 0x0f, defaultName: 'DisplayPort 1', label: '', include: true, detected: true },
			{ value: 0x11, defaultName: 'HDMI 1', label: '', include: true, detected: true }
		]);
	});

	it('includes only spec-listed inputs and carries custom labels', () => {
		const rows = sourceEditorRows([0x0f, 0x11, 0x12], '0x11=Desktop, 0x12');
		expect(rows).toEqual([
			{ value: 0x0f, defaultName: 'DisplayPort 1', label: '', include: false, detected: true },
			{ value: 0x11, defaultName: 'HDMI 1', label: 'Desktop', include: true, detected: true },
			{ value: 0x12, defaultName: 'HDMI 2', label: '', include: true, detected: true }
		]);
	});

	it('appends spec entries the monitor did not report as manual rows', () => {
		const rows = sourceEditorRows([0x11], '0x11, 0x1b=Console');
		expect(rows).toEqual([
			{ value: 0x11, defaultName: 'HDMI 1', label: '', include: true, detected: true },
			{ value: 0x1b, defaultName: 'Input 0x1B', label: 'Console', include: true, detected: false }
		]);
	});

	it('de-duplicates a repeated value in `detected`, keeping only the first row', () => {
		const rows = sourceEditorRows([0x11, 0x11, 0x12], '');
		expect(rows.map((r) => r.value)).toEqual([0x11, 0x12]);
	});

	it('leaves a manual (undetected) row unlabeled when its spec label matches the default name', () => {
		// No explicit `=label` on the 0x1b entry → parseSourceSpec defaults its label to inputName(0x1b),
		// so p.label === defaultName and the manual row's `label` stays '' (not the redundant default).
		const rows = sourceEditorRows([0x11], '0x11, 0x1b');
		expect(rows).toEqual([
			{ value: 0x11, defaultName: 'HDMI 1', label: '', include: true, detected: true },
			{ value: 0x1b, defaultName: 'Input 0x1B', label: '', include: true, detected: false }
		]);
	});
});

describe('buildSourceSpec', () => {
	it('returns blank (auto) when all detected inputs are included with default names', () => {
		expect(buildSourceSpec(sourceEditorRows([0x0f, 0x11], ''))).toBe('');
	});

	it('emits an explicit code=label spec for a renamed/filtered set', () => {
		const rows = sourceEditorRows([0x0f, 0x11, 0x12], '');
		rows[0].include = false; // drop DisplayPort 1
		rows[2].label = 'Switch 2'; // rename HDMI 2
		expect(buildSourceSpec(rows)).toBe('0x11, 0x12=Switch 2');
	});

	it('round-trips through parseSourceSpec', () => {
		const rows = sourceEditorRows([0x11, 0x12], '0x11=Desktop, 0x12=Switch 2');
		expect(parseSourceSpec(buildSourceSpec(rows))).toEqual([
			{ value: 0x11, label: 'Desktop' },
			{ value: 0x12, label: 'Switch 2' }
		]);
	});
});
