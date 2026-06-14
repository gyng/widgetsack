// Framework-agnostic formatting helpers (no Svelte/Tauri). Pure and unit-tested;
// reused as-is by a future React port.

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

/** Human-readable bytes with binary (1024) scaling. */
export function formatBytes(bytes: number, decimals = 1): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${BYTE_UNITS[0]}`;
	const i = Math.min(
		BYTE_UNITS.length - 1,
		Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024)))
	);
	const scaled = bytes / 1024 ** i;
	return `${scaled.toFixed(i === 0 ? 0 : decimals)} ${BYTE_UNITS[i]}`;
}

/** A compact "used / total UNIT" pair that shares ONE unit (scaled to the total), e.g.
 * `12.3 GiB / 16.0 GiB` → `12.3 / 16.0 GiB`. Used for the GPU panel's VRAM readout, where the
 * per-stat grid cell is narrow — dropping the redundant first unit keeps it from ellipsizing. */
export function formatBytesPair(used: number, total: number, decimals = 1): string {
	if (!Number.isFinite(total) || total <= 0) {
		return `${formatBytes(used, decimals)} / ${formatBytes(total, decimals)}`;
	}
	const i = Math.min(
		BYTE_UNITS.length - 1,
		Math.max(0, Math.floor(Math.log(total) / Math.log(1024)))
	);
	const scale = 1024 ** i;
	const fmt = (b: number) => (Math.max(0, b) / scale).toFixed(i === 0 ? 0 : decimals);
	return `${fmt(used)} / ${fmt(total)} ${BYTE_UNITS[i]}`;
}

/** Bytes-per-second as a human-readable rate. */
export function formatRate(bytesPerSec: number, decimals = 1): string {
	return `${formatBytes(bytesPerSec, decimals)}/s`;
}

/** A percentage with fixed decimals. */
export function formatPercent(value: number, decimals = 0): string {
	return `${value.toFixed(decimals)}%`;
}

/** A whole-seconds duration as a compact, uptime-style string (two most-significant
 * units): '3d 4h', '4h 12m', '12m 8s', '8s'. Negative/non-finite → '0s'. */
export function formatDuration(totalSeconds: number): string {
	if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0s';
	const s = Math.floor(totalSeconds);
	const days = Math.floor(s / 86400);
	const hours = Math.floor((s % 86400) / 3600);
	const mins = Math.floor((s % 3600) / 60);
	const secs = s % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${mins}m`;
	if (mins > 0) return `${mins}m ${secs}s`;
	return `${secs}s`;
}

// The named scalar formats `formatScalar` understands (the `format` config field on text-like
// widgets). Source of truth for the generated templating docs (core/templatingDocs.ts) and a
// drift guard: format.test.ts asserts every name here is actually handled (not the raw fallback).
// Any other `format` value renders the raw number.
export type ScalarFormat = { name: string; summary: string; example: string };
export const SCALAR_FORMATS: ScalarFormat[] = [
	{ name: 'integer', summary: 'Rounded to a whole number.', example: '37' },
	{ name: 'percent', summary: 'A whole-number percentage with a `%` suffix.', example: '37%' },
	{
		name: 'rate',
		summary: 'Bytes/second, binary-scaled, with a `/s` suffix.',
		example: '1.0 KiB/s'
	},
	{
		name: 'bytes',
		summary: 'Binary-scaled bytes (B / KiB / MiB / GiB / TiB).',
		example: '16.0 GiB'
	},
	{
		name: 'duration',
		summary: 'A whole-seconds duration, two most-significant units.',
		example: '3d 4h'
	}
];

/** Format a scalar sensor value by a named format (see SCALAR_FORMATS); any other name → raw. */
export function formatScalar(value: number | null, format: string): string {
	if (value === null) return '–';
	switch (format) {
		case 'percent':
			return formatPercent(value);
		case 'rate':
			return formatRate(value);
		case 'bytes':
			return formatBytes(value);
		case 'duration':
			return formatDuration(value);
		case 'integer':
			return Math.round(value).toString();
		default:
			return value.toString();
	}
}

// A sensible default format (a `formatScalar` name) inferred from a sensor id's naming
// convention — so the studio Sensors list renders byte/rate/duration sensors nicely instead of as
// raw numbers, and callers have one place to ask "how should this id be shown". Pure + unit-tested;
// the conventions mirror the ids emitted by widgetsack/src/sensors.rs. Text-kind sensors
// (cpu.brand, gpu.name, battery.state) never reach this — they render as their string.
const RATE_SENSOR_IDS = new Set([
	'net.down',
	'net.up',
	'net.total',
	'net.linkspeed.rx',
	'net.linkspeed.tx',
	'gpu.pcie.rx',
	'gpu.pcie.tx'
]);
const DURATION_SENSOR_IDS = new Set(['host.uptime', 'battery.time', 'host.idle']);
const PERCENT_SENSOR_IDS = new Set([
	'cpu.total',
	'mem.used',
	'swap.used',
	'gpu.util',
	'gpu.vram',
	'gpu.mem.util',
	'gpu.fan',
	'battery.percent'
]);
const INTEGER_SENSOR_IDS = new Set([
	'host.procs',
	'host.handles',
	'host.threads',
	'cpu.cores.logical',
	'cpu.cores.physical',
	'cpu.freq',
	'cpu.freq.current',
	'cpu.freq.max',
	'gpu.clock.core',
	'gpu.clock.mem',
	'gpu.power',
	'gpu.power.limit',
	'battery.rate',
	'battery.capacity.full',
	'battery.capacity.remaining'
]);
// Byte-valued ids whose suffix isn't caught by the generic byte regex (commit/cache/kernel pools).
const BYTE_SENSOR_IDS = new Set([
	'mem.commit.used',
	'mem.commit.limit',
	'mem.commit.peak',
	'mem.cached',
	'mem.kernel.paged',
	'mem.kernel.nonpaged'
]);

/** Best-guess `formatScalar` format name for a sensor id (e.g. 'mem.total' → 'bytes',
 * 'net.down' → 'rate', 'host.uptime' → 'duration', 'cpu.total' → 'percent', 'cpu.core.3.freq' →
 * 'integer'). Precedence matters: the `.freq` check sits before the per-core percent rule so a
 * per-core FREQUENCY isn't mistaken for per-core USAGE. */
export function guessSensorFormat(id: string): string {
	if (RATE_SENSOR_IDS.has(id)) return 'rate';
	if (/^disk\..+\.(read|write)$/.test(id)) return 'rate'; // disk.<letter>.read / .write (bytes/s)
	if (DURATION_SENSOR_IDS.has(id)) return 'duration';
	if (id.endsWith('.pct')) return 'percent';
	if (id.endsWith('.freq')) return 'integer'; // cpu.freq, cpu.core.N.freq (MHz)
	if (INTEGER_SENSOR_IDS.has(id)) return 'integer';
	if (PERCENT_SENSOR_IDS.has(id) || id.startsWith('cpu.core.')) return 'percent';
	if (BYTE_SENSOR_IDS.has(id)) return 'bytes';
	// byte-valued absolutes: *.total, *.free, *.available, *.used, *.used.bytes (disk/mem/swap/vram).
	if (/\.(total|free|available|used)$/.test(id) || id.endsWith('.used.bytes')) return 'bytes';
	return 'integer';
}

const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];
const MONTHS_SHORT = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec'
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Localized month/day names (Sunday-first, matching Date.getDay()). `ddd` in 'ja' gives the
// single-kanji weekday glyph (日月火水木金土) the DateTime skin used. Extend with more
// locales as needed; an unknown locale falls back to English.
type LocaleNames = { months: string[]; monthsShort: string[]; days: string[]; daysShort: string[] };
const MONTHS_JA = [
	'1月',
	'2月',
	'3月',
	'4月',
	'5月',
	'6月',
	'7月',
	'8月',
	'9月',
	'10月',
	'11月',
	'12月'
];
const LOCALES: Record<string, LocaleNames> = {
	en: { months: MONTHS, monthsShort: MONTHS_SHORT, days: DAYS, daysShort: DAYS_SHORT },
	ja: {
		months: MONTHS_JA,
		monthsShort: MONTHS_JA,
		days: ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'],
		daysShort: ['日', '月', '火', '水', '木', '金', '土']
	},
	// Chinese: numeric months read the same as Japanese ("6月"); the short weekday is the day-number
	// glyph (Sun 日, Mon 一 … Sat 六), the long form 星期X.
	zh: {
		months: MONTHS_JA,
		monthsShort: MONTHS_JA,
		days: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
		daysShort: ['日', '一', '二', '三', '四', '五', '六']
	}
};

/** The 7 weekday names for `locale`, Sunday-first (index = Date.getDay()): `style:'short'` is the
 * compact form (Sun / 日 …), 'long' the full form. Unknown locale falls back to English. Returns a
 * copy. The Calendar widget rotates these by its configured first day-of-week. */
export function localeDayNames(locale = 'en', style: 'short' | 'long' = 'short'): string[] {
	const names = LOCALES[locale] ?? LOCALES.en;
	return [...(style === 'long' ? names.days : names.daysShort)];
}

const pad2 = (n: number): string => n.toString().padStart(2, '0');

const CLOCK_TOKEN = /\[([^\]]*)\]|YYYY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|hh|h|mm|m|ss|s|A|a/g;

/** Format a Date with a moment-like token string. Wrap literals in [brackets]. `locale` selects
 * the month/day names ('en' default; 'ja' renders Japanese weekday glyphs for ddd/dddd). */
export function formatClock(date: Date, format: string, locale = 'en'): string {
	const names = LOCALES[locale] ?? LOCALES.en;
	const h24 = date.getHours();
	const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
	const tokens: Record<string, string> = {
		YYYY: date.getFullYear().toString(),
		MMMM: names.months[date.getMonth()],
		MMM: names.monthsShort[date.getMonth()],
		MM: pad2(date.getMonth() + 1),
		M: (date.getMonth() + 1).toString(),
		dddd: names.days[date.getDay()],
		ddd: names.daysShort[date.getDay()],
		DD: pad2(date.getDate()),
		D: date.getDate().toString(),
		HH: pad2(h24),
		H: h24.toString(),
		hh: pad2(h12),
		h: h12.toString(),
		mm: pad2(date.getMinutes()),
		m: date.getMinutes().toString(),
		ss: pad2(date.getSeconds()),
		s: date.getSeconds().toString(),
		A: h24 < 12 ? 'AM' : 'PM',
		a: h24 < 12 ? 'am' : 'pm'
	};
	return format.replace(CLOCK_TOKEN, (match: string, literal: string | undefined) =>
		literal !== undefined ? literal : tokens[match]
	);
}
