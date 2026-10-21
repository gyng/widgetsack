// Presentational meter (molecule): formats a scalar sensor value as text. Themeable via
// tokens (--np-fg / -font); a per-instance `color` (from config) overrides --np-fg.
import { formatRate, formatScalar } from '../../core/format';
import Sparkline from './Sparkline';
import './Text.css';

type Props = {
	// number from a bound sensor; string when driven by a text formula (already rendered by the engine).
	value?: number | string | null;
	format?: string;
	label?: string;
	color?: string;
	history?: number[];
	showSparkline?: boolean;
	sparklineSeconds?: number;
	sparklineWidth?: number;
	sparklineStretch?: boolean;
	sparklineSmooth?: boolean;
	sparklineDelay?: number;
	sparklineScale?: 'auto' | 'percent';
};

/** Nothing to show: no label and no value (unbound / not yet sampled / an empty formula result).
 *  Exported for the host-side tests; pure. */
export function isEmptyText(value: number | string | null | undefined, label: string): boolean {
	if (label.trim()) return false;
	return value == null || (typeof value === 'string' && value.trim() === '');
}

export default function Text({
	value = null,
	format = 'integer',
	label = '',
	color,
	history = [],
	showSparkline = false,
	sparklineSeconds = 60,
	sparklineWidth = 40,
	sparklineStretch = false,
	sparklineSmooth = true,
	sparklineDelay = 1.5,
	sparklineScale = 'auto'
}: Props) {
	const display = typeof value === 'string' ? value : formatScalar(value, format);
	const colorCss = color ?? 'var(--np-fg, rgb(255, 255, 255))';
	// With nothing to show, a freshly added Text is an invisible sliver on the stage. Render a
	// placeholder as well; the editor's host class (`.widget.editable`, CSS) swaps it in for the dash
	// ONLY in edit mode — the passive overlay keeps rendering the plain "–" (Text.css).
	const empty = isEmptyText(value, label);

	return (
		<div
			className={`text np-text${empty ? ' empty' : ''}${format.startsWith('rate') ? ' rate' : ''}`}
			style={{ color: colorCss }}
		>
			{label && (
				<span className="label" data-part="label">
					{label}
				</span>
			)}
			<span
				className="value"
				data-part="value"
				title={format === 'rate-short' && typeof value === 'number' ? formatRate(value) : undefined}
			>
				{display}
			</span>
			{showSparkline && (
				<span
					className={`text-sparkline${sparklineStretch ? ' stretch' : ''}`}
					data-part="history"
					title={`${sparklineSeconds}s history`}
					style={sparklineStretch ? undefined : { width: sparklineWidth }}
				>
					<Sparkline
						history={history}
						seconds={sparklineSeconds}
						min={0}
						max={sparklineScale === 'percent' ? 100 : null}
						color="currentColor"
						fill={false}
						smooth={sparklineSmooth}
						smoothDelay={sparklineDelay}
					/>
				</span>
			)}
			{empty && (
				<span className="placeholder" data-part="placeholder" aria-hidden="true">
					Text
				</span>
			)}
		</div>
	);
}
