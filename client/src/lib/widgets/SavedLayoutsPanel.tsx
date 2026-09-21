// Presets section (extracted from Canvas): save this monitor's arrangement under a name, load one
// back, delete one. Purely a panel — the file I/O + the outcome line live in canvas/useSavedLayouts
// and arrive as props. The name is an inline field + Save button (no prompt()); the outcome
// ("Saved preset X · N presets" / the failure reason) renders right under it. Lazy-loadable like the
// other studio panels.
import { useState } from 'react';
import type { PresetStatus } from './canvas/useSavedLayouts';

type Props = {
	layoutNames: string[];
	status: PresetStatus;
	onSave: (name: string) => void;
	onLoad: (name: string) => void;
	onDelete: (name: string) => void;
};

export default function SavedLayoutsPanel({
	layoutNames,
	status,
	onSave,
	onLoad,
	onDelete
}: Props) {
	const [name, setName] = useState('');
	return (
		<div className="rail-panel presets-panel">
			<div className="rp-hd">Presets</div>
			<div className="rp-stub">
				Save this monitor’s arrangement as a named preset, then load it back later.
			</div>
			<form
				className="preset-save"
				onSubmit={(e) => {
					e.preventDefault();
					onSave(name);
				}}
			>
				<input
					type="text"
					value={name}
					placeholder="Preset name"
					aria-label="Preset name"
					spellCheck={false}
					onChange={(e) => setName(e.currentTarget.value)}
				/>
				<button type="submit" disabled={!name.trim()}>
					⤓ Save
				</button>
			</form>
			{status && (
				<div
					className={
						status.kind === 'error'
							? 'rp-stub preset-status preset-status--err'
							: 'rp-stub preset-status'
					}
					role={status.kind === 'error' ? 'alert' : 'status'}
				>
					{status.message}
				</div>
			)}
			<div className="rp-hd">Load</div>
			{layoutNames.length ? (
				<div className="rp-list">
					{layoutNames.map((n) => (
						<div className="rp-list-row" key={n}>
							<button
								type="button"
								title="Replace this monitor’s layout with this preset (Ctrl+Z restores it)"
								onClick={() => onLoad(n)}
							>
								⤒ {n}
							</button>
							<button
								type="button"
								className="rp-danger"
								title="Delete this preset"
								aria-label={`Delete preset ${n}`}
								onClick={() => onDelete(n)}
							>
								✕
							</button>
						</div>
					))}
				</div>
			) : (
				<div className="rp-stub">No presets yet — save one above.</div>
			)}
		</div>
	);
}
