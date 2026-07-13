// Monitor Switch meter (presentational, props-only). Renders a title (+ optional resolution/refresh
// stats) and one clickable row per selectable input source, marking the active one. The wiring (list
// monitors, read current input, switch via DDC/CI) lives in the sibling MonitorSwitchHost; this just
// renders rows and calls `onPick`. BARE DOM; styled in MonitorSwitch.css via --np-* / --ms-* tokens.
import type { CSSProperties } from 'react';
import type { MonitorInputRow } from '../../core/monitorInputs';
import './MonitorSwitch.css';

type Props = {
	title: string;
	rows: MonitorInputRow[];
	stats?: string;
	showStats?: boolean;
	busyValue?: number | null;
	// The configured monitor isn't present (unplugged / switched away / wrong id) — show a hint
	// instead of buttons that would target nothing.
	missing?: boolean;
	loading?: boolean;
	unavailable?: boolean;
	// Compact list (small rows) instead of the default large touch buttons.
	compact?: boolean;
	onPick: (value: number) => void;
	color?: string;
};

export default function MonitorSwitch({
	title,
	rows,
	stats,
	showStats,
	busyValue,
	missing,
	loading,
	unavailable,
	compact,
	onPick,
	color
}: Props) {
	const vars = color ? ({ '--ms-accent': color } as CSSProperties) : undefined;

	return (
		<div
			className="monitorswitch np-monitorswitch"
			data-compact={compact || undefined}
			style={vars}
		>
			<div className="ms-head">
				<span className="ms-title">{title}</span>
				{showStats && stats ? <span className="ms-stats">{stats}</span> : null}
			</div>
			{loading ? (
				<div className="ms-empty" data-part="empty">
					loading…
				</div>
			) : missing ? (
				<div className="ms-empty" data-part="empty">
					monitor not found
				</div>
			) : unavailable ? (
				<div className="ms-empty" data-part="empty">
					no DDC monitor found
				</div>
			) : rows.length === 0 ? (
				<div className="ms-empty" data-part="empty">
					—
				</div>
			) : (
				<div className="ms-list">
					{rows.map((r) => (
						<button
							type="button"
							key={r.value}
							className="ms-row"
							data-active={r.active || undefined}
							data-busy={busyValue === r.value || undefined}
							aria-pressed={r.active}
							aria-busy={busyValue === r.value || undefined}
							disabled={busyValue != null}
							onClick={() => onPick(r.value)}
							title={r.label}
						>
							<span className="ms-name">{r.label}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
