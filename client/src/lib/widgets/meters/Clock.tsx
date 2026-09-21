// Self-sourcing meter: renders local time on the shared 1 s wall clock (useNow — one boundary-aligned
// timer per window, so every clock flips on the true second). No sensor binding. BARE DOM — the look lives
// in Clock.css; a per-instance `color` is passed only as the `--clock-color` CSS variable (the class
// resolves it with a --np-fg/token fallback), so it stays fully restylable via the editable css.
import { type CSSProperties } from 'react';
import { formatClock } from '../../core/format';
import { useNow } from '../useNow';
import './Clock.css';

type Props = {
	format?: string;
	label?: string;
	color?: string;
	// Month/day-name locale: 'en' (default) or 'ja' (ddd → 日月火水木金土 weekday glyphs).
	locale?: string;
};

export default function Clock({ format = 'HH:mm', label = '', color, locale = 'en' }: Props) {
	const now = new Date(useNow(1000));

	const display = formatClock(now, format, locale);
	const vars = color ? ({ '--clock-color': color } as CSSProperties) : undefined;

	return (
		<div className="clock np-clock" style={vars}>
			<span className="value" data-part="value">
				{display}
			</span>
			{label && (
				<span className="label" data-part="label">
					{label}
				</span>
			)}
		</div>
	);
}
