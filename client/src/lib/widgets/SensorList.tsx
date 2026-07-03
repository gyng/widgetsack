// A live list of sensors and their current values (the studio's full-screen Sensors section). Each
// row subscribes to one sensor via useSensor, so values tick in place. Ids come from the union of
// the hub's seen sensors + every source's catalog (so not-yet-emitted sensors still show as "—").
// Optionally: a filter box (with a live count), collapsible groups by source, and/or a per-row
// "from <plugin>" badge — the Sensors section groups by source; the Plugins section uses a plain list.
import { memo, useState } from 'react';
import { useSensor } from './useSensor';
import { displaySensorValue, filterSensorIds, groupSensorIds } from '../core/sensorList';
import type { SensorActivity } from '../core/sensorActivity';
import type { TelemetryHub } from '../core/telemetry';

// Memoized: a catalog can be hundreds of rows, each with its own live useSensor subscription. Without
// memo, any SensorList parent re-render (the studio Canvas, on any interaction) reconciles every row;
// memo keeps a re-render scoped to the rows whose own sensor actually ticked (or whose props changed).
const SensorRow = memo(function SensorRow({
	hub,
	id,
	badge,
	activity
}: {
	hub: TelemetryHub;
	id: string;
	badge?: string | null;
	activity?: SensorActivity | null;
}) {
	const state = useSensor(hub, id);
	const value = displaySensorValue(id, state.value);
	return (
		<div className="rp-row" title={id}>
			{activity ? (
				// After-close fate, told apart by SHAPE (not colour alone — WCAG 1.4.1): ★ = a widget keeps
				// it alive, ● = a cheap always-on sensor, ○ = studio-only (stops on close).
				<span
					className={`sensor-dot ${activity.referenced ? 'on' : activity.active ? 'amb' : 'off'}`}
					title={activity.reason}
					aria-label={
						activity.referenced
							? 'used by a widget — stays active after the studio closes'
							: activity.active
								? 'always-on — stays active after the studio closes'
								: 'studio-only — stops when the studio closes'
					}
				>
					{activity.referenced ? '★' : activity.active ? '●' : '○'}
				</span>
			) : null}
			<span className="rp-id">{id}</span>
			{badge ? (
				<span className="rp-badge" title={`from the ${badge} plugin`}>
					{badge}
				</span>
			) : null}
			<span className="dim" title={value}>
				{value}
			</span>
		</div>
	);
});

type Props = {
	hub: TelemetryHub;
	ids: string[];
	/** Show a filter box + live count above the list (the full Sensors section). */
	filter?: boolean;
	/** Group the rows into collapsible sections by this label (e.g. source). Implies the source is
	 * shown in the group header, so per-row badges are suppressed. */
	groupFor?: (id: string) => string;
	/** Plugin name for a sensor id (→ a "from X" badge) in the flat (ungrouped) list, or null. */
	badgeFor?: (id: string) => string | null;
	/** Per-sensor "stays active after the studio closes?" verdict (→ a status dot + why tooltip). */
	activityFor?: (id: string) => SensorActivity | null;
};

export default function SensorList({
	hub,
	ids,
	filter = false,
	groupFor,
	badgeFor,
	activityFor
}: Props) {
	const [query, setQuery] = useState('');
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

	const grid = (list: string[]) => (
		<div className="rp-sensors">
			{list.map((id) => (
				// In grouped mode the header carries the source, so the per-row badge is suppressed.
				<SensorRow
					key={id}
					hub={hub}
					id={id}
					badge={groupFor ? null : (badgeFor?.(id) ?? null)}
					activity={activityFor?.(id) ?? null}
				/>
			))}
		</div>
	);

	if (!filter) {
		if (!ids.length) return <div className="rp-stub">No sensors yet.</div>;
		return grid(ids);
	}

	const shown = filterSensorIds(ids, query);
	const filterBox = (
		<div className="rp-filter">
			<input
				type="search"
				value={query}
				placeholder="Filter sensors…"
				aria-label="Filter sensors"
				onInput={(e) => setQuery(e.currentTarget.value)}
			/>
			<span className="rp-count">
				{shown.length === ids.length ? ids.length : `${shown.length} / ${ids.length}`}
			</span>
		</div>
	);

	// At-a-glance "what survives the studio closing": referenced by widgets / cheap always-on / stops.
	const verdicts = activityFor ? ids.map((id) => activityFor(id)) : [];
	const refN = verdicts.filter((v) => v?.referenced).length;
	const activeN = verdicts.filter((v) => v?.active).length;
	const legend = activityFor ? (
		<div
			className="rp-sensor-legend"
			title="Which sensors keep being sampled once you close the studio"
		>
			<span>
				<span className="sensor-dot on">★</span> {refN} used by widgets
			</span>
			<span>
				<span className="sensor-dot amb">●</span> {activeN - refN} always-on
			</span>
			<span>
				<span className="sensor-dot off">○</span> {ids.length - activeN} studio-only
			</span>
			<span className="rp-count">
				{activeN}/{ids.length} stay active after close
			</span>
		</div>
	) : null;

	if (shown.length === 0) {
		return (
			<>
				{filterBox}
				<div className="rp-stub">{ids.length === 0 ? 'No sensors yet.' : 'No sensors match.'}</div>
			</>
		);
	}

	if (groupFor) {
		const toggle = (label: string) =>
			setCollapsed((prev) => {
				const next = new Set(prev);
				if (next.has(label)) next.delete(label);
				else next.add(label);
				return next;
			});
		return (
			<>
				{filterBox}
				{legend}
				{groupSensorIds(shown, groupFor).map((g) => {
					const isCollapsed = collapsed.has(g.label);
					return (
						<div key={g.label} className="rp-group">
							<button
								type="button"
								className="rp-group-hd"
								aria-expanded={!isCollapsed}
								onClick={() => toggle(g.label)}
							>
								<span className="rp-group-caret" aria-hidden="true">
									{isCollapsed ? '▸' : '▾'}
								</span>
								<span className="rp-group-name">{g.label}</span>
								<span className="rp-count">{g.ids.length}</span>
							</button>
							{!isCollapsed && grid(g.ids)}
						</div>
					);
				})}
			</>
		);
	}

	return (
		<>
			{filterBox}
			{legend}
			{grid(shown)}
		</>
	);
}
