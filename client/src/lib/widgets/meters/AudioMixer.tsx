import type { MixerSnapshot } from '../../audio/mixer';
import './Dashboard.css';
export default function AudioMixer({
	snapshot,
	error,
	busy,
	showMicrophone,
	editMode,
	onLevel,
	onMute,
	onMicrophone
}: {
	snapshot: MixerSnapshot | null;
	error: string;
	busy: boolean;
	showMicrophone: boolean;
	editMode: boolean;
	onLevel: (id: string, level: number) => void;
	onMute: (id: string, muted: boolean) => void;
	onMicrophone: (muted: boolean) => void;
}) {
	return (
		<section className="np-dashboard" aria-label="App audio mixer">
			<header>App audio mixer</header>
			{showMicrophone && (
				<div className="dashboard-row">
					<span>
						Microphone ·{' '}
						{snapshot?.microphone ? (snapshot.microphone.muted ? 'muted' : 'live') : 'unavailable'}
					</span>
					<button
						disabled={busy || editMode || !snapshot?.microphone}
						onClick={() => onMicrophone(!snapshot?.microphone?.muted)}
					>
						{snapshot?.microphone?.muted ? 'Unmute mic' : 'Mute mic'}
					</button>
				</div>
			)}
			{snapshot?.sessions.map((s) => (
				<div className="dashboard-row" key={s.id}>
					<span>{s.name}</span>
					<input
						type="range"
						min={0}
						max={100}
						value={Math.round(s.level * 100)}
						disabled={editMode}
						aria-label={`${s.name} volume`}
						onChange={(e) => onLevel(s.id, Number(e.target.value) / 100)}
					/>
					<button
						disabled={busy || editMode}
						aria-label={`${s.name} ${s.muted ? 'unmute' : 'mute'}`}
						onClick={() => onMute(s.id, !s.muted)}
					>
						{s.muted ? 'Unmute' : 'Mute'}
					</button>
				</div>
			))}
			{snapshot && !snapshot.sessions.length && (
				<span>{snapshot.sessionError ? 'App audio unavailable' : 'No app audio sessions'}</span>
			)}
			{snapshot?.sessionError && <span role="alert">{snapshot.sessionError}</span>}
			{!snapshot && !error && <span>Loading…</span>}
			{error && <span role="alert">{error}</span>}
		</section>
	);
}
