import ICAL from 'ical.js';

type WallTime = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
};
const utcWall = (time: WallTime): number => {
	const date = new Date(0);
	date.setUTCFullYear(time.year, time.month - 1, time.day);
	date.setUTCHours(time.hour, time.minute, time.second, 0);
	return date.getTime();
};

/** An IANA timezone adapter for feeds which omit VTIMEZONE. Resolve folds to the first
 * occurrence, and gaps with the preceding offset, as RFC5545 requires. */
export function browserTimezone(
	tzid: string,
	cacheSize = 8192
): InstanceType<typeof ICAL.Timezone> {
	const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
		timeZone: tzid,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23'
	});
	const offsetAt = (instant: number): number => {
		const parts = Object.fromEntries(
			formatter.formatToParts(instant).map((part) => [part.type, part.value])
		);
		return (
			(utcWall({
				year: Number(parts.year),
				month: Number(parts.month),
				day: Number(parts.day),
				hour: Number(parts.hour),
				minute: Number(parts.minute),
				second: Number(parts.second)
			}) -
				instant) /
			1000
		);
	};
	const zone = new ICAL.Timezone({ tzid });
	const offsets = new Map<number, number>();
	zone.utcOffset = (time) => {
		const wall = utcWall(time);
		const cached = offsets.get(wall);
		if (cached !== undefined) return cached;
		const previous = offsetAt(wall - 36 * 3600000);
		const candidates = [...new Set([previous, offsetAt(wall), offsetAt(wall + 36 * 3600000)])].sort(
			(a, b) => b - a
		);
		const offset =
			candidates.find((candidate) => offsetAt(wall - candidate * 1000) === candidate) ?? previous;
		if (offsets.size >= cacheSize) offsets.clear();
		offsets.set(wall, offset);
		return offset;
	};
	return zone;
}

/** Parse the raw VTIMEZONE offset before ICAL.UtcOffset can wrap it or discard seconds. */
export function calendarOffsetSeconds(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const match = /^([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
	if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59)
		return null;
	const magnitude = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0);
	return match[1] === '-' ? -magnitude : magnitude;
}
