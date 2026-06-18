// Interactive HA meter (molecule): a media_player — now-playing text + transport (prev / play-pause /
// next) + a volume slider with mute. Reads title/artist/state/volume from the entity JSON
// (binds: 'json'); controls emit onControl (media_player.media_play_pause / media_next_track /
// media_previous_track / volume_set / volume_mute) which Canvas turns into ha_call_service. volume
// service_data is built by the pure core/haControls helper. Prop-only (AGENTS.md §6).
// (Album art is deferred — entity_picture is a token-auth'd HA URL that needs a backend proxy.)
import { mediaVolumeSet } from '../../core/haControls';
import type { ControlEvent } from '../meterProps';
import './HaControls.css';

type HaState = { state?: string; attributes?: Record<string, unknown> };

type Props = {
	value?: unknown;
	label?: string;
	onControl?: (e: ControlEvent) => void;
	showTransport?: boolean;
	showVolume?: boolean;
};

export default function HaMediaPlayer({
	value = null,
	label,
	onControl,
	showTransport = true,
	showVolume = true
}: Props) {
	const s = (value ?? null) as HaState | null;
	const state = s?.state ?? '—';
	const attrs = (s?.attributes ?? {}) as Record<string, unknown>;
	const name = label ?? (attrs.friendly_name as string | undefined) ?? 'Media';
	const title = attrs.media_title as string | undefined;
	const artist =
		(attrs.media_artist as string | undefined) ??
		(attrs.media_series_title as string | undefined) ??
		(attrs.app_name as string | undefined);
	const playing = state === 'playing';
	const active = state !== 'off' && state !== 'unavailable' && state !== 'standby';
	const vol = attrs.volume_level as number | undefined; // 0..1
	const muted = attrs.is_volume_muted === true;
	const hasVolume = showVolume && vol != null;

	const call = (service: string, data?: Record<string, unknown>): void =>
		onControl?.({ domain: 'media_player', service, ...(data ? { data } : {}) });
	const setVol = (pct: number): void => {
		const c = mediaVolumeSet(pct);
		call(c.service, c.data);
	};

	return (
		<div className="ha-media np-ha-media" data-part="root">
			<span className="label" data-part="label">
				{name}
			</span>
			<span className="now" data-part="value">
				{title ?? (active ? state : 'idle')}
				{artist ? ` · ${artist}` : ''}
			</span>
			{showTransport && active && (
				<div className="ha-media-tx" data-part="controls">
					<button
						type="button"
						aria-label={`Previous on ${name}`}
						onClick={() => call('media_previous_track')}
					>
						⏮
					</button>
					<button
						type="button"
						aria-label={playing ? `Pause ${name}` : `Play ${name}`}
						onClick={() => call('media_play_pause')}
					>
						{playing ? '⏸' : '▶'}
					</button>
					<button
						type="button"
						aria-label={`Next on ${name}`}
						onClick={() => call('media_next_track')}
					>
						⏭
					</button>
				</div>
			)}
			{hasVolume && (
				<div className="ha-media-vol" data-part="volume">
					<button
						type="button"
						className={muted ? 'on' : ''}
						aria-label={`Mute ${name}`}
						aria-pressed={muted}
						onClick={() => call('volume_mute', { is_volume_muted: !muted })}
					>
						{muted ? '🔇' : '🔊'}
					</button>
					<input
						type="range"
						min={0}
						max={100}
						value={Math.round((vol ?? 0) * 100)}
						aria-label={`${name} volume`}
						onChange={(e) => setVol(Number(e.currentTarget.value))}
					/>
				</div>
			)}
		</div>
	);
}
