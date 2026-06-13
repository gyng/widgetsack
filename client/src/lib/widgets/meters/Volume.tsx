// Volume meter (presentational, props-only): a mute toggle + a level slider + a % readout. The Tauri
// wiring (read/set the system master volume) lives in the sibling VolumeHost; this just renders and
// calls back. interactive:true on the meta so the controls work on the passive overlay. BARE DOM;
// styled in Volume.css via --np-* / --vol-* tokens.
import type { CSSProperties } from 'react';
import { volumeIcon, volumePercent } from '../../core/volume';
import './Volume.css';

type Props = {
	level?: number | null;
	muted?: boolean;
	onSet?: (level: number) => void;
	onToggleMute?: () => void;
	color?: string;
};

export default function Volume({ level = null, muted = false, onSet, onToggleMute, color }: Props) {
	const pct = volumePercent(level);
	const icon = volumeIcon(level, muted);
	const vars = color ? ({ '--vol-accent': color } as CSSProperties) : undefined;

	return (
		<div className="volume np-volume" style={vars} data-muted={muted || undefined}>
			<button
				type="button"
				className="vol-mute"
				onClick={() => onToggleMute?.()}
				title={muted ? 'Unmute' : 'Mute'}
				aria-label={muted ? 'Unmute' : 'Mute'}
			>
				<span className="vol-icon">{icon}</span>
			</button>
			<input
				className="vol-slider"
				type="range"
				min={0}
				max={100}
				value={pct}
				onChange={(e) => onSet?.(Number(e.currentTarget.value) / 100)}
				aria-label="volume"
				style={{ '--vol-fill': `${pct}%` } as CSSProperties}
			/>
			<span className="vol-pct" data-part="value">
				{level == null ? '—' : `${pct}%`}
			</span>
		</div>
	);
}
