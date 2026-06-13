// Audio Switcher meter (presentational, props-only). Lists the output devices and lets the user pick
// one to make default — the wiring (list / read default / set default via Tauri) lives in the sibling
// AudioSwitcherHost; this just renders rows and calls `onPick`. The active device floats to the top and
// is marked. BARE DOM; styled in AudioSwitcher.css via --np-* tokens.
import type { CSSProperties } from 'react';
import { audioDeviceRows, type AudioDevice } from '../../core/audioDevices';
import './AudioSwitcher.css';

type Props = {
	devices: AudioDevice[];
	currentId: string | null;
	onPick: (id: string) => void;
	busyId?: string | null;
	color?: string;
};

export default function AudioSwitcher({ devices, currentId, onPick, busyId, color }: Props) {
	const rows = audioDeviceRows(devices, currentId);
	const vars = color ? ({ '--as-accent': color } as CSSProperties) : undefined;

	return (
		<div className="audioswitch np-audioswitch" style={vars}>
			<div className="as-head">
				<span className="as-title">🔊 Output</span>
			</div>
			{rows.length === 0 ? (
				<div className="as-empty" data-part="empty">
					—
				</div>
			) : (
				<div className="as-list">
					{rows.map((d) => (
						<button
							type="button"
							key={d.id}
							className="as-row"
							data-active={d.active || undefined}
							data-busy={busyId === d.id || undefined}
							onClick={() => onPick(d.id)}
							title={d.name}
						>
							<span className="as-dot" aria-hidden="true" />
							<span className="as-name">{d.name}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
