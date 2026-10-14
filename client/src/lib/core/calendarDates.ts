import ICAL from 'ical.js';

function validDate(value: unknown): boolean {
	if (typeof value !== 'string') return false;
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})Z?)?$/.exec(value);
	if (!match) return false;
	const year = Number(match[1]),
		month = Number(match[2]),
		day = Number(match[3]);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return (
		month >= 1 &&
		month <= 12 &&
		day >= 1 &&
		day <= days[month - 1] &&
		(match[4] === undefined ||
			(Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 60))
	);
}

/** Validate before ICAL.Time can normalize an invalid date. RDATE periods contribute
 * their start times: Agenda and reminders display starts, not event durations. */
export function normalizeCalendarDates(component: InstanceType<typeof ICAL.Component>): void {
	for (const property of component.getAllProperties()) {
		if (!['date', 'date-time', 'period'].includes(property.type)) continue;
		const values = (property.toJSON() as unknown[]).slice(3);
		if (
			!values.every((value) =>
				validDate(property.type === 'period' && Array.isArray(value) ? value[0] : value)
			)
		)
			throw new Error('Invalid calendar date');
		if (property.name === 'rdate' && property.type === 'period') {
			const periods = property.getValues() as InstanceType<typeof ICAL.Period>[];
			const starts = periods.map((period) => period.start);
			property.resetType('date-time');
			property.setValues(starts);
		}
	}
}
