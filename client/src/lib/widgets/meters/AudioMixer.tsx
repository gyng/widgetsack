import type { MixerSnapshot } from '../../audio/mixer';
import './Dashboard.css';
import './AudioMixer.css';
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
		<section className="np-dashboard np-audio-mixer" aria-label="App audio mixer">
			<header>App audio mixer</header>
			{showMicrophone && (
				<div className="mixer-microphone">
					<div className="mixer-details">
						<span className="mixer-name">Microphone</span>
						<span className="mixer-status">
							{snapshot?.microphone
								? snapshot.microphone.muted
									? 'muted'
									: 'live'
								: 'unavailable'}
						</span>
					</div>
					<button
						className="mixer-mute"
						aria-label={snapshot?.microphone?.muted ? 'Unmute mic' : 'Mute mic'}
						aria-pressed={snapshot?.microphone?.muted === true}
						disabled={busy || editMode || !snapshot?.microphone}
						onClick={() => onMicrophone(!snapshot?.microphone?.muted)}
					>
						{snapshot?.microphone?.muted ? 'Unmute' : 'Mute'}
					</button>
				</div>
			)}
			{snapshot?.sessions.map((s) => (
				<div className="mixer-session" key={s.id}>
					<span className="mixer-name" title={s.name}>
						{s.name}
					</span>
					<div className="mixer-controls">
						<input
							type="range"
							min={0}
							max={100}
							value={Math.round(s.level * 100)}
							disabled={editMode}
							aria-label={`${s.name} volume`}
							onChange={(e) => onLevel(s.id, Number(e.target.value) / 100)}
						/>
						<output className="mixer-level" aria-label={`${s.name} volume level`}>
							{Math.round(s.level * 100)}%
						</output>
						<button
							className="mixer-mute"
							aria-pressed={s.muted}
							disabled={busy || editMode}
							aria-label={`${s.name} ${s.muted ? 'unmute' : 'mute'}`}
							onClick={() => onMute(s.id, !s.muted)}
						>
							{s.muted ? 'Unmute' : 'Mute'}
						</button>
					</div>
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
