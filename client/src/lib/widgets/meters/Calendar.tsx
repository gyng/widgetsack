// Self-sourcing meter: a month calendar grid (like Clock, it has no sensor — it reads the local date
// on a slow tick so "today" stays current across midnight). BARE DOM; the look lives in Calendar.css,
// driven by tokens with --np-* fallbacks so it's fully restylable via the editable css. The grid logic
// is pure (core/calendar.ts); this only renders it.
import { useEffect, useState, type CSSProperties } from 'react';
import { buildCalendar, weekdayOrder, type CalMode } from '../../core/calendar';
import { formatClock, localeDayNames } from '../../core/format';
import './Calendar.css';

type Props = {
	// Which weekday starts a row (English name; the locale only affects the displayed labels).
	firstDay?: string;
	weekdayHeader?: boolean; // show the weekday label row
	continuous?: boolean; // extend dimmed through the end of next month's week
	highlightToday?: boolean;
	showTitle?: boolean; // the "June 2026" header
	locale?: string; // weekday / month names: 'en' | 'ja' | 'zh'
	color?: string;
};

const FIRST_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function Calendar({
	firstDay = 'Sunday',
	weekdayHeader = true,
	continuous = false,
	highlightToday = true,
	showTitle = true,
	locale = 'en',
	color
}: Props) {
	// Re-read the date every 60s so `isToday` flips within a minute of midnight (a calendar needs no
	// faster tick). Like Clock, this is the documented self-sourcing exception for a time widget.
	const [now, setNow] = useState(new Date());
	useEffect(() => {
		const timer = setInterval(() => setNow(new Date()), 60_000);
		return () => clearInterval(timer);
	}, []);

	const firstDayIdx = Math.max(0, FIRST_DAYS.indexOf(firstDay));
	const mode: CalMode = continuous ? 'continuous' : 'month';
	const weeks = buildCalendar({
		year: now.getFullYear(),
		month: now.getMonth(),
		firstDay: firstDayIdx,
		mode,
		today: highlightToday
			? { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() }
			: undefined
	});
	const headers = weekdayHeader ? weekdayOrder(localeDayNames(locale, 'short'), firstDayIdx) : null;
	const vars = color ? ({ '--cal-accent': color } as CSSProperties) : undefined;
	const monthLabel = formatClock(now, 'MMMM YYYY', locale);

	return (
		<div className="calendar np-calendar" style={vars} data-continuous={continuous || undefined}>
			{showTitle && (
				<div className="cal-title" data-part="title">
					{monthLabel}
				</div>
			)}
			<div className="cal-grid" data-part="grid" role="grid" aria-label={monthLabel}>
				{headers && (
					<div className="cal-row cal-head" role="row">
						{headers.map((name, i) => (
							<span key={i} className="cal-wd" role="columnheader">
								{name}
							</span>
						))}
					</div>
				)}
				{weeks.map((week, wi) => (
					<div key={wi} className="cal-row" role="row">
						{week.map((day) => {
							const cls = ['cal-day'];
							if (!day.inMonth) cls.push('cal-out');
							if (day.isToday) cls.push('cal-today');
							if (day.isWeekend) cls.push('cal-weekend');
							return (
								<span
									key={`${day.y}-${day.m}-${day.d}`}
									className={cls.join(' ')}
									role="gridcell"
									aria-current={day.isToday ? 'date' : undefined}
								>
									{day.d}
								</span>
							);
						})}
					</div>
				))}
			</div>
		</div>
	);
}
