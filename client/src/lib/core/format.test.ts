import { describe, expect, it } from 'vitest';
import {
	formatBytes,
	formatBytesPair,
	formatClock,
	formatDuration,
	formatPercent,
	formatRate,
	formatScalar,
	guessSensorFormat,
	localeDayNames,
	SCALAR_FORMATS
} from './format';

describe('formatBytes', () => {
	it('scales with binary units', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(1536)).toBe('1.5 KiB');
		expect(formatBytes(1048576)).toBe('1.0 MiB');
	});

	it('handles zero and non-finite input', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(Number.NaN)).toBe('0 B');
	});
});

describe('formatBytesPair', () => {
	it('shares one unit scaled to the total (compact VRAM readout)', () => {
		// 6 GiB / 12 GiB → "5.6 / 11.2 GiB" (one unit, not "5.6 GiB / 11.2 GiB")
		expect(formatBytesPair(6_000_000_000, 12_000_000_000)).toBe('5.6 / 11.2 GiB');
	});
	it('scales the used value to the total unit even when much smaller', () => {
		expect(formatBytesPair(512 * 1024 * 1024, 16 * 1024 ** 3)).toBe('0.5 / 16.0 GiB');
	});
	it('falls back to two units when the total is missing/zero', () => {
		expect(formatBytesPair(1024, 0)).toContain('/');
	});
	it('drops decimals entirely in the plain-byte range (unit index 0)', () => {
		expect(formatBytesPair(100, 512)).toBe('100 / 512 B');
	});
});

describe('formatRate / formatPercent', () => {
	it('formats a byte rate', () => {
		expect(formatRate(1048576)).toBe('1.0 MiB/s');
	});

	it('formats percentages with fixed decimals', () => {
		expect(formatPercent(42.7)).toBe('43%');
		expect(formatPercent(42.7, 1)).toBe('42.7%');
	});
});

describe('formatScalar', () => {
	it('routes by named format', () => {
		expect(formatScalar(50, 'percent')).toBe('50%');
		expect(formatScalar(2048, 'rate')).toBe('2.0 KiB/s');
		expect(formatScalar(3.6, 'integer')).toBe('4');
	});

	it('shows a placeholder for null', () => {
		expect(formatScalar(null, 'percent')).toBe('–');
	});

	it('routes the duration and bytes formats', () => {
		expect(formatScalar(90061, 'duration')).toBe('1d 1h');
		expect(formatScalar(17179869184, 'bytes')).toBe('16.0 GiB');
	});

	// Drift guard for the generated templating docs: every documented named format must actually be
	// HANDLED by the switch (not fall through to the raw number).
	it('handles every SCALAR_FORMATS name (none falls through to raw)', () => {
		for (const f of SCALAR_FORMATS) {
			expect(formatScalar(1234.5, f.name)).not.toBe((1234.5).toString());
		}
		expect(formatScalar(1234.5, 'nope')).toBe('1234.5'); // an unlisted format → raw
	});
});

describe('formatDuration', () => {
	it('shows the two most-significant units', () => {
		expect(formatDuration(0)).toBe('0s');
		expect(formatDuration(45)).toBe('45s');
		expect(formatDuration(125)).toBe('2m 5s');
		expect(formatDuration(3 * 3600 + 12 * 60 + 9)).toBe('3h 12m');
		expect(formatDuration(3 * 86400 + 4 * 3600 + 30 * 60)).toBe('3d 4h');
	});

	it('guards negative and non-finite input', () => {
		expect(formatDuration(-5)).toBe('0s');
		expect(formatDuration(Number.NaN)).toBe('0s');
	});
});

describe('guessSensorFormat', () => {
	it('maps byte/total absolutes to bytes', () => {
		for (const id of [
			'mem.total',
			'mem.used.bytes',
			'mem.available',
			'mem.free',
			'swap.total',
			'gpu.vram.total',
			'gpu.vram.used',
			'gpu.vram.free',
			'disk.c.total',
			'disk.c.free',
			'disk.c.used',
			'net.down.total',
			'net.up.total'
		]) {
			expect(guessSensorFormat(id)).toBe('bytes');
		}
	});

	it('keeps the percent ids (incl. per-core and .pct) as percent', () => {
		for (const id of ['cpu.total', 'cpu.core.7', 'mem.used', 'gpu.vram', 'disk.c.used.pct']) {
			expect(guessSensorFormat(id)).toBe('percent');
		}
	});

	it('maps rates, durations, counts and clocks', () => {
		expect(guessSensorFormat('net.total')).toBe('rate');
		expect(guessSensorFormat('net.down')).toBe('rate');
		expect(guessSensorFormat('host.uptime')).toBe('duration');
		expect(guessSensorFormat('battery.time')).toBe('duration');
		expect(guessSensorFormat('host.idle')).toBe('duration');
		expect(guessSensorFormat('host.procs')).toBe('integer');
		expect(guessSensorFormat('host.handles')).toBe('integer');
		expect(guessSensorFormat('cpu.freq')).toBe('integer');
		expect(guessSensorFormat('gpu.clock.core')).toBe('integer');
	});

	it('handles the Windows commit/cache/kernel byte ids and live CPU clocks', () => {
		for (const id of [
			'mem.commit.used',
			'mem.commit.limit',
			'mem.commit.peak',
			'mem.cached',
			'mem.kernel.paged',
			'mem.kernel.nonpaged'
		]) {
			expect(guessSensorFormat(id)).toBe('bytes');
		}
		// Live CPU clocks are MHz integers; per-core FREQUENCY must not be read as per-core usage %.
		expect(guessSensorFormat('cpu.freq.current')).toBe('integer');
		expect(guessSensorFormat('cpu.freq.max')).toBe('integer');
		expect(guessSensorFormat('cpu.core.3.freq')).toBe('integer');
		expect(guessSensorFormat('cpu.core.3')).toBe('percent');
	});

	it('handles disk I/O, network link, and battery power ids', () => {
		// Live disk I/O: throughput is a rate, active-time is a percent.
		expect(guessSensorFormat('disk.c.read')).toBe('rate');
		expect(guessSensorFormat('disk.c.write')).toBe('rate');
		expect(guessSensorFormat('disk.c.busy.pct')).toBe('percent');
		// Capacity ids on the same drive stay bytes / percent.
		expect(guessSensorFormat('disk.c.total')).toBe('bytes');
		expect(guessSensorFormat('disk.c.used.pct')).toBe('percent');
		// Network link speed is a rate (bytes/s); battery power/energy are integers.
		expect(guessSensorFormat('net.linkspeed.rx')).toBe('rate');
		expect(guessSensorFormat('net.linkspeed.tx')).toBe('rate');
		expect(guessSensorFormat('battery.rate')).toBe('integer');
		expect(guessSensorFormat('battery.capacity.remaining')).toBe('integer');
	});

	it('falls back to integer for an id matching no known shape', () => {
		expect(guessSensorFormat('weird.sensor')).toBe('integer');
	});
});

describe('localeDayNames', () => {
	it('defaults to short English weekday names, Sunday-first', () => {
		expect(localeDayNames()).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
	});

	it('returns long English weekday names when asked', () => {
		expect(localeDayNames('en', 'long')).toEqual([
			'Sunday',
			'Monday',
			'Tuesday',
			'Wednesday',
			'Thursday',
			'Friday',
			'Saturday'
		]);
	});

	it('returns short/long Japanese weekday names', () => {
		expect(localeDayNames('ja', 'short')).toEqual(['日', '月', '火', '水', '木', '金', '土']);
		expect(localeDayNames('ja', 'long')[1]).toBe('月曜日');
	});

	it('falls back to English for an unknown locale', () => {
		expect(localeDayNames('xx')).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
	});

	it('returns a fresh copy each call (not a shared reference)', () => {
		const a = localeDayNames();
		a[0] = 'mutated';
		expect(localeDayNames()[0]).toBe('Sun');
	});
});

describe('formatClock', () => {
	// 2026-06-01 09:05:03 local — a Monday
	const d = new Date(2026, 5, 1, 9, 5, 3);

	it('formats time tokens', () => {
		expect(formatClock(d, 'HH:mm:ss')).toBe('09:05:03');
		expect(formatClock(d, 'h:mm A')).toBe('9:05 AM');
	});

	it('formats date tokens', () => {
		expect(formatClock(d, 'dddd')).toBe('Monday');
		expect(formatClock(d, 'ddd D MMMM YYYY')).toBe('Mon 1 June 2026');
	});

	it('preserves bracketed literals', () => {
		expect(formatClock(d, '[on] dddd')).toBe('on Monday');
	});

	it('renders Japanese weekday/month names for locale ja', () => {
		// Monday → 月 (ddd) / 月曜日 (dddd); June → 6月
		expect(formatClock(d, 'ddd', 'ja')).toBe('月');
		expect(formatClock(d, 'dddd', 'ja')).toBe('月曜日');
		expect(formatClock(d, 'MMMM', 'ja')).toBe('6月');
		// time tokens are locale-independent
		expect(formatClock(d, 'HH:mm ddd', 'ja')).toBe('09:05 月');
	});

	it('renders Chinese weekday/month names for locale zh', () => {
		// Monday → 一 (ddd) / 星期一 (dddd); June → 6月
		expect(formatClock(d, 'ddd', 'zh')).toBe('一');
		expect(formatClock(d, 'dddd', 'zh')).toBe('星期一');
		expect(formatClock(d, 'MMMM', 'zh')).toBe('6月');
	});

	it('falls back to English for an unknown locale', () => {
		expect(formatClock(d, 'ddd', 'xx')).toBe('Mon');
	});

	it('renders 12 for the noon/midnight hour and PM/pm after midday', () => {
		const noon = new Date(2026, 5, 1, 12, 0, 0);
		expect(formatClock(noon, 'h A')).toBe('12 PM');
		expect(formatClock(noon, 'hh a')).toBe('12 pm');
		const midnight = new Date(2026, 5, 1, 0, 30, 0);
		expect(formatClock(midnight, 'h:mm A')).toBe('12:30 AM');
	});
});
