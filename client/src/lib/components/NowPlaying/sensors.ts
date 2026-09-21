// Pure derivation of the now-playing `np.*` telemetry sensors from the active media session — the
// single source of truth shared by the media->hub bridge (np-source.ts) and the settings pane's
// live-values table (NowPlayingSettings.tsx). Framework-agnostic (no React/Tauri): takes a session
// in and returns SensorSamples out, so it's unit-tested directly. Mirrors what the NowPlaying meter
// reads — metadata from last_media_update.Media[0], playback/timeline from the LIVE
// last_model_update.Model — so the sensors match exactly what the widget shows.

import type { SensorSample, SensorValue } from '../../core/telemetry';
import type { SessionRecord } from '../../../stores/stores';

// Stable, ordered id list — returned verbatim by the source's catalog() so the inspector's sensor
// dropdown lists np.* before any sample arrives and never flickers as tracks change. APPEND-ONLY:
// reordering/removing would break saved widget bindings. Kept in lockstep with mediaSensorSamples
// (a test asserts the emitted ids equal this list).
export const NP_SENSOR_IDS = [
	'np.title',
	'np.artist',
	'np.album',
	'np.source',
	'np.status',
	'np.playing',
	'np.position',
	'np.duration',
	'np.progress',
	'np.shuffle',
	'np.repeat'
];

/** Derive the `np.*` samples from the active session (the one the widget would show). An undefined
 * session (nothing playing) yields empty text + zeroed scalars so bound widgets read a clean idle
 * state rather than going stale. `tsMs` stamps every sample (wall-clock from the caller). */
export function mediaSensorSamples(
	session: SessionRecord | undefined,
	tsMs: number
): SensorSample[] {
	// Metadata (title/artist/album) comes from the MEDIA update; playback + timeline from the MODEL
	// update — the one that fires on play/pause/seek, while the media update's copy stays stale until
	// the next track change (same split as NowPlaying.tsx). Fall back to the media model before any
	// model update arrives.
	const mediaModel = session?.last_media_update?.Media?.[0];
	const liveModel = session?.last_model_update?.Model ?? mediaModel;
	const media = mediaModel?.media;
	const playback = liveModel?.playback;
	const timeline = liveModel?.timeline;
	const position = timeline?.position ?? 0;
	const duration = timeline?.end ?? 0;
	const progress = duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0;

	const text = (value: string): SensorValue => ({ kind: 'text', value });
	const scalar = (value: number): SensorValue => ({ kind: 'scalar', value });

	const values: Record<string, SensorValue> = {
		'np.title': text(media?.title ?? ''),
		'np.artist': text(media?.artist ?? ''),
		'np.album': text(media?.album?.title ?? ''),
		'np.source': text(session?.source ?? ''),
		'np.status': text(playback?.status ?? ''),
		'np.playing': scalar(playback?.status === 'Playing' ? 1 : 0),
		'np.position': scalar(position),
		'np.duration': scalar(duration),
		'np.progress': scalar(progress),
		'np.shuffle': scalar(playback?.shuffle ? 1 : 0),
		'np.repeat': text(playback?.auto_repeat ?? '')
	};

	return NP_SENSOR_IDS.map((sensor) => ({ sensor, ts_ms: tsMs, value: values[sensor] }));
}
