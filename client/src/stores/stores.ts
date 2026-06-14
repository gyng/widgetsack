import { createPersistedStore } from './persist';
import { mergeMediaForward, upsertSession } from '../lib/components/NowPlaying/priority';

export type ManagerEventWrapper = unknown;

export type SessionUpdateEventWrapper = unknown;

export type UnsupportedEvent = [number | null, string];

export type SystemTime = {
	nanos_since_epoch: number;
	secs_since_epoch: number;
};

export type SessionRecord = {
	session_id: number;
	source: string;
	timestamp_created: SystemTime | null;
	timestamp_updated: SystemTime | null;
	// Both mirror Rust `Option<SessionUpdateEventWrapper>` (state.rs) — nullable. The backend also now
	// omits `last_media_update` (sends null) on model/timeline updates to avoid re-shipping the album-art
	// bytes every play/pause/seek tick; the frontend carries the prior media forward (see mergeMediaForward).
	last_media_update: SessionUpdateEventMedia | null;
	last_model_update: SessionUpdateEventModel | null;
};

export type MonitorInfo = {
	name: string | null;
	position: { x: number; y: number };
	size: { width: number; height: number };
};

export type SavedPosition = {
	x: number;
	y: number;
	width: number;
	height: number;
	timestamp: number;
};

export type State = {
	sessions: Record<string, SessionRecord>;
	sourcePriority: string;
	// Newline-separated source ids to hide entirely (lowercased). A session is dropped from the
	// now-playing selection if any non-blank line is a substring of its source — see filterIgnored.
	ignoreList: string;
	styleOverride: string;
	preferredMonitor: MonitorInfo | null;
	savedPosition: SavedPosition | null;
	restoreToSavedPosition: boolean;
};

export type SerializedState = Pick<
	State,
	| 'sourcePriority'
	| 'ignoreList'
	| 'styleOverride'
	| 'preferredMonitor'
	| 'savedPosition'
	| 'restoreToSavedPosition'
>;

export type PlaybackType = 'Unknown' | 'Music' | 'Video' | 'Image';
export type PlaybackStatus = 'Closed' | 'Opened' | 'Changing' | 'Stopped' | 'Playing' | 'Paused';
export type AutoRepeat = 'None' | 'Track' | 'List';

export type SessionModel = {
	playback: PlaybackModel | null;
	timeline: TimelineModel | null;
	media: MediaModel | null;
	source: string;
};

export type MediaModel = {
	album: AlbumModel | null;
	artist: string;
	genres: string[];
	playback_type: PlaybackType;
	subtitle: string;
	title: string;
	track_number: number | null;
};

export type AlbumModel = {
	artist: string;
	title: string;
	track_count: number;
};

export type PlaybackModel = {
	auto_repeat: AutoRepeat;
	rate: number;
	shuffle: boolean;
	status: PlaybackStatus;
	type: PlaybackType;
};

export type TimelineModel = {
	end: number;
	last_updated_at_ms: number;
	position: number;
	start: number;
};

// Album-art descriptor mirroring the Rust `ImageWrapper` serialization (widgetsack/src/listener.rs).
// The cover bytes are NOT shipped over the JSON bridge any more — `url` points the `<img>` at the
// backend `art` URI-scheme handler (art.rs), and `bytes` is the retained byte count for the studio
// Diagnostics panel (see sumArtBytes). Keep in sync with `ImageWrapper::serialize` (AGENTS.md §5).
export type ThumbnailInfo = { content_type?: string; url?: string; bytes?: number };
export type SessionUpdateEventMedia = { Media: [SessionModel, ThumbnailInfo | null] };
export type SessionUpdateEventModel = { Model: SessionModel };

export const defaultState: State = {
	sessions: {},
	sourcePriority: ['SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', 'foobar2000.exe']
		.join('\n')
		.toLowerCase(),
	ignoreList: '',
	styleOverride: '',
	preferredMonitor: null,
	savedPosition: null,
	restoreToSavedPosition: false
};

// Persistence: only the user-preference subset of State survives restarts (`SerializedState`);
// live `sessions` are runtime-only and re-seeded over the bridge. Legacy key, predates the
// 'widgetsack.*' namespace convention.
const MEDIA_STORE_KEY = '_mediaStore';

function parseMediaStore(raw: unknown): State {
	// TODO: Validate deserialised values and do migrations if needed
	const o = (raw ?? {}) as Partial<SerializedState>;
	return {
		...defaultState,
		...(o.sourcePriority !== undefined && { sourcePriority: o.sourcePriority }),
		...(o.ignoreList !== undefined && { ignoreList: o.ignoreList }),
		...(o.styleOverride !== undefined && { styleOverride: o.styleOverride }),
		...(o.preferredMonitor !== undefined && { preferredMonitor: o.preferredMonitor }),
		...(o.savedPosition !== undefined && { savedPosition: o.savedPosition }),
		...(o.restoreToSavedPosition !== undefined && {
			restoreToSavedPosition: o.restoreToSavedPosition
		})
	};
}

function serializeMediaStore(value: State): SerializedState {
	return {
		sourcePriority: value.sourcePriority,
		ignoreList: value.ignoreList,
		styleOverride: value.styleOverride,
		preferredMonitor: value.preferredMonitor,
		savedPosition: value.savedPosition,
		restoreToSavedPosition: value.restoreToSavedPosition
	};
}

export const mediaStore = createPersistedStore<State>(
	MEDIA_STORE_KEY,
	parseMediaStore,
	serializeMediaStore
);

export type HandleInitializeOpts = { sessions: Record<number, SessionRecord> };
export function handleInitialize(opts: HandleInitializeOpts) {
	if (!opts) return;

	mediaStore.update((cur) => {
		// Fold the backend snapshot through upsertSession so a same-source duplicate in the initial
		// set can't seed the leak at startup (the live overlay path uses the same eviction).
		const sessions = Object.values(opts.sessions).reduce<Record<number, SessionRecord>>(
			(acc, rec) => upsertSession(acc, rec),
			{}
		);
		return {
			...cur,
			sessions
		};
	});
}

export type HandleUpdateOpts = {
	sessionRecord: SessionRecord;
};
export function handleUpdate(opts: HandleUpdateOpts) {
	mediaStore.update((cur) => {
		// Restore the album art the backend omits on model/timeline updates (carried forward by id), then
		// upsert keyed by session_id while evicting any stale record for the SAME source — a player that
		// recreates its SMTC session would otherwise leak an orphaned record (with its album-art bytes)
		// per recreation, OOMing the overlay over time.
		const record = mergeMediaForward(
			cur.sessions[opts.sessionRecord.session_id],
			opts.sessionRecord
		);
		return {
			...cur,
			sessions: upsertSession(cur.sessions, record)
		};
	});
}

export type HandleDeleteOpts = {
	sessionRecord: SessionRecord;
};
export function handleDelete(opts: HandleDeleteOpts) {
	mediaStore.update((cur) => {
		const copy = { ...cur };
		const copySessions = copy.sessions;
		delete copySessions[opts.sessionRecord.session_id];
		return copy;
	});
}
