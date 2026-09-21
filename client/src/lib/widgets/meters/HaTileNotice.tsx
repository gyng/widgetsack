// The shared "instead of a value" body for the Home Assistant tiles: when core/haTileState says
// the tile has no live data (plugin not configured / connection down / entity unavailable / still
// waiting), every HA meter renders THIS in place of its value, keeping its own root class so
// per-widget CSS + themes still target the same element. Presentational: props in, DOM out.
import type { HaTileState } from '../../core/haTileState';
import './HaControls.css';

type Props = {
	className: string;
	label: string;
	tile: Exclude<HaTileState, { kind: 'ok' }>;
};

export default function HaTileNotice({ className, label, tile }: Props) {
	return (
		<div className={className} data-part="root" data-tile-state={tile.kind}>
			<span className="label" data-part="label">
				{label}
			</span>
			<span className="value ha-tile-notice" data-part="value" role="status">
				{tile.message}
			</span>
		</div>
	);
}
