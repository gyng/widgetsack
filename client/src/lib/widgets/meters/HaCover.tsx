// Interactive HA meter (molecule): a cover (blinds/garage) — open / stop / close buttons + an
// optional position slider for covers that report current_position. Reads from the entity JSON
// (binds: 'json'); controls emit onControl (cover.open_cover / stop_cover / close_cover /
// set_cover_position) which Canvas turns into ha_call_service. Prop-only (AGENTS.md §6).
import { coverSetPosition } from '../../core/haControls';
import type { ControlEvent } from '../meterProps';
import { haTileState } from '../../core/haTileState';
import HaTileNotice from './HaTileNotice';
import './HaControls.css';

type HaState = { state?: string; attributes?: Record<string, unknown> };

type Props = {
	value?: unknown;
	/** The `ha.status` sample (host-supplied): undefined = not wired, null = no status heard yet. */
	haStatus?: string | null;
	label?: string;
	onControl?: (e: ControlEvent) => void;
	showButtons?: boolean;
	showPosition?: boolean;
};

export default function HaCover({
	value = null,
	haStatus,
	label,
	onControl,
	showButtons = true,
	showPosition = true
}: Props) {
	const s = (value ?? null) as HaState | null;
	const state = s?.state ?? '—';
	const attrs = (s?.attributes ?? {}) as Record<string, unknown>;
	const name = label ?? (attrs.friendly_name as string | undefined) ?? 'Cover';
	const position = attrs.current_position as number | undefined; // 0 (closed) .. 100 (open)
	const hasPosition = showPosition && position != null;

	const call = (service: string) => onControl?.({ domain: 'cover', service });
	const setPos = (p: number) => {
		const c = coverSetPosition(p);
		onControl?.({ domain: 'cover', service: c.service, data: c.data });
	};

	// No live data (plugin unset / offline / entity unavailable / still waiting) → the shared notice.
	const tile = haTileState(haStatus, value);
	if (tile.kind !== 'ok')
		return <HaTileNotice className="ha-cover np-ha-cover" label={name} tile={tile} />;

	return (
		<div className="ha-cover np-ha-cover" data-part="root">
			<span className="label" data-part="label">
				{name}
			</span>
			<span className="state" data-part="state">
				{hasPosition ? `${Math.round(position)}%` : state}
			</span>
			{showButtons && (
				<div className="ha-cover-btns" data-part="controls">
					<button type="button" aria-label={`Open ${name}`} onClick={() => call('open_cover')}>
						▲
					</button>
					<button type="button" aria-label={`Stop ${name}`} onClick={() => call('stop_cover')}>
						■
					</button>
					<button type="button" aria-label={`Close ${name}`} onClick={() => call('close_cover')}>
						▼
					</button>
				</div>
			)}
			{hasPosition && (
				<input
					type="range"
					min={0}
					max={100}
					value={Math.round(position)}
					className="ha-cover-pos"
					data-part="position"
					aria-label={`${name} position`}
					onChange={(e) => setPos(Number(e.currentTarget.value))}
				/>
			)}
		</div>
	);
}
