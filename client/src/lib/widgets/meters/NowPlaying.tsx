// Props-only media meter: renders the now-playing track it is GIVEN. The wiring — booting the GSMTC
// feed, subscribing to mediaStore, picking the active session (priority sort), fetching transport
// capabilities — lives in the NowPlayingHost container (../NowPlayingHost.tsx, AGENTS.md §6). Renders
// STRUCTURE only — the default look (font / sizes / colors / fades) ships as the instance's editable
// `css` (NOWPLAYING_DEFAULT_CSS) so it's fully restylable. Cover sits above the title/artist and is
// contained to the box (no fixed aspect, never overflows the cell). The progress bar, timers and
// transport controls are present in the DOM but HIDDEN by default — un-hide them via css for
// players that expose a timeline (foobar2000 does not, so they stay idle there).
//
// Visual behaviours, each driven purely by css on the parts below (so they stay fully restylable):
//   • play/pause fade — the root carries `data-playing`; the css dims it when paused (full on hover).
//   • crossfade — album art renders as stacked layers: a new track's cover fades in over the previous
//     one (removed once the new one has fully faded in), so a song change never flashes empty/black.
//   • song-change grey — the instant the TRACK flips, the cover still showing the previous song is
//     marked `data-leaving` and the css desaturates it to grey (a "now stale" cue, like the paused
//     dim). Immediate and separate from the crossfade, so it fires even before the new art arrives.
import {
	useEffect,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type TransitionEvent as ReactTransitionEvent
} from 'react';
// Type-only imports (erased at build): the session shape mirrors the Rust structs; MediaCaps
// mirrors widgetsack/src/media.rs. No runtime store/Tauri dependency remains here.
import type { SessionRecord } from '../../../stores/stores';
import type { MediaCaps } from '../../components/NowPlaying/source';

type Props = {
	// The session to render (the host picks the highest-priority one); undefined = no player.
	session?: SessionRecord | null;
	// Which controls the session supports — buttons it doesn't are hidden. null = unknown (no
	// backend / no session / not yet fetched): show everything rather than hide the basics.
	caps?: MediaCaps | null;
	label?: string;
	// Transport buttons bubble a media control up; WidgetHost adds the widget identity and Canvas
	// makes the Tauri `media_control` call (the meter stays prop-only / Tauri-free, AGENTS.md §6).
	onControl?: (e: { domain: string; service: string; data?: Record<string, unknown> }) => void;
};

// Grace period before clearing the cover when a track has no art: long enough that a new track's art
// (which often lags its metadata) crossfades in instead, short enough that a genuinely art-less track
// doesn't keep showing the previous cover. If no art arrives in time, the stale cover fades out.
const NO_ART_GRACE_MS = 1200;
// How long the previous track's cover stays greyed before recovering to colour IF nothing replaces
// it — i.e. the next track reuses the SAME cover bytes (same album → no crossfade fires to clear the
// grey). When the art does change, the crossfade removes the greyed layer well before this elapses.
const GREY_HOLD_MS = 900;

type ArtLayer = { id: number; url: string; loaded: boolean; leaving?: boolean };

const fmtTime = (v: number): string => {
	const s = Math.max(0, Math.floor(v));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function NowPlaying({ session, caps = null, label, onControl }: Props) {
	const source = session?.source;
	// Metadata (title/artist/album/art) comes from the MEDIA update; playback + timeline come from the
	// MODEL update — that's the one that fires on play/pause/seek, while the media update's copy stays
	// stale until the next track change. Fall back to the media model before any model update arrives.
	const mediaModel = session?.last_media_update?.Media?.[0];
	const liveModel = session?.last_model_update?.Model ?? mediaModel;
	const media = mediaModel?.media;
	// Whether there's a CURRENT track to show. The cover (and its crossfade/no-art grace) only makes
	// sense while a track is present; when the session has no media — player stopped, or recreated its
	// SMTC session on pause so the prior track can't be carried forward — there's nothing to label the
	// cover, so it must leave WITH the title rather than linger (expanding to fill the box) on the grace.
	const hasMedia = !!media;
	const title = media?.title ?? label ?? '';
	const artist = media?.artist ?? '';
	const timeline = liveModel?.timeline;
	const position = timeline?.position ?? 0;
	const duration = timeline?.end ?? 0;
	const progress = duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0;
	const playback = liveModel?.playback;
	const playing = playback?.status === 'Playing';
	const shuffle = playback?.shuffle ?? false;
	const repeatMode = playback?.auto_repeat ?? 'None';
	// Cycle None → Track → List → None (the value the backend maps to MediaPlaybackAutoRepeatMode).
	const nextRepeat = repeatMode === 'None' ? 1 : repeatMode === 'Track' ? 2 : 0;
	const thumb = session?.last_media_update?.Media?.[1];

	// --- album-art crossfade ---
	// The cover arrives as a backend-served URL (http://art.localhost/<hash>, art.rs) rather than raw
	// bytes. The hash in the URL is a content signature, so artKey changes only on a REAL art change
	// (new track / late-arriving art), never on play/pause re-sends of the same cover. Read the cover
	// from a ref so the effect depends on the signature (the url) alone.
	const thumbRef = useRef(thumb);
	// Keep the latest thumb (and whether a track is present) in refs, written in a commit effect (not
	// during render) so the crossfade effect below can depend on the art SIGNATURE (artKey) alone yet
	// still read the current values. Declared before that effect so it runs first and the refs are
	// fresh when the effect reads them.
	const hasMediaRef = useRef(hasMedia);
	useEffect(() => {
		thumbRef.current = thumb;
		hasMediaRef.current = hasMedia;
	});
	const artKey = thumb?.url ?? '';
	// A stable identity for the *track* (not the art): changes on a song change but not on play/pause
	// or seek. Drives the immediate grey cue, independent of when the (often-lagging) art arrives.
	const trackKey = `${source ?? ''}\0${title}\0${artist}`;

	const [layers, setLayers] = useState<ArtLayer[]>([]);
	const layersRef = useRef(layers);
	// Mirror layers into a ref (commit effect, not a during-render write) so the crossfade effect can
	// read the current layers without listing them as a dependency. Runs before that effect.
	useEffect(() => {
		layersRef.current = layers;
	});
	const seqRef = useRef(0);
	const clearTimerRef = useRef<number | null>(null);
	const greyTimerRef = useRef<number | null>(null);
	const prevTrackRef = useRef(trackKey);
	const hasSession = !!session;

	// Player gone, or the session has no current track (media gone) → drop every cover layer. Done as
	// an adjust-during-render (React re-renders before paint) rather than a setState inside the
	// crossfade effect below, which would cascade. Media-gone matters as much as session-gone: a
	// paused/idle session that still HAS a track keeps its cover up, but one whose track left must
	// drop the cover with it — the no-art grace below only bridges art that lags its metadata.
	const showsArt = hasSession && hasMedia;
	const [prevShowsArt, setPrevShowsArt] = useState(showsArt);
	if (showsArt !== prevShowsArt) {
		setPrevShowsArt(showsArt);
		if (!showsArt) setLayers([]);
	}

	// Song-change grey cue — see the file header. Declared before the crossfade effect so that when a
	// track AND its art change in the same tick, the visible cover is already marked leaving when the
	// crossfade picks it up as the outgoing layer.
	useEffect(() => {
		if (prevTrackRef.current === trackKey) return;
		prevTrackRef.current = trackKey;
		if (greyTimerRef.current !== null) clearTimeout(greyTimerRef.current);
		// Grey only the currently-visible (loaded) cover(s); a not-yet-shown incoming layer stays colour.
		setLayers((prev) =>
			prev.some((l) => l.loaded) ? prev.map((l) => (l.loaded ? { ...l, leaving: true } : l)) : prev
		);
		// Recover to colour if nothing replaces it (same-album art reuse), so it never sticks grey.
		greyTimerRef.current = window.setTimeout(() => {
			greyTimerRef.current = null;
			setLayers((prev) => prev.map((l) => (l.loaded ? { ...l, leaving: false } : l)));
		}, GREY_HOLD_MS);
	}, [trackKey]);

	useEffect(() => {
		// This render supersedes any pending no-art teardown.
		if (clearTimerRef.current !== null) {
			clearTimeout(clearTimerRef.current);
			clearTimerRef.current = null;
		}
		// Player gone, or no current track → the layers were already cleared above (adjust-during-
		// render); skip the art-push AND the no-art grace here so nothing re-lingers. A paused/idle
		// session that still has a track keeps its cover up. hasMedia is read from its ref so this
		// effect keeps depending on the art signature (artKey) + session presence alone.
		if (!hasSession || !hasMediaRef.current) return;
		const url = thumbRef.current?.url;
		if (!url) {
			// No art *right now* — usually a track change whose cover just lags its metadata, so KEEP the
			// previous cover up so the new one can crossfade in over it. Guard against a genuinely art-
			// less track, though: if no art arrives within the grace window, fade the stale cover out.
			if (layersRef.current.length > 0) {
				clearTimerRef.current = window.setTimeout(() => {
					clearTimerRef.current = null;
					// Drop never-shown layers outright (nothing to fade); fade the visible one(s) out —
					// loaded:false runs the reverse transition, and each self-removes on transitionend.
					setLayers((prev) => prev.filter((l) => l.loaded).map((l) => ({ ...l, loaded: false })));
				}, NO_ART_GRACE_MS);
			}
			return;
		}
		const id = seqRef.current + 1;
		seqRef.current = id;
		setLayers((prev) => {
			// Keep ONLY the most-recent VISIBLE cover to fade out under the incoming one, and drop every
			// other layer (older covers, plus never-shown ones still at opacity:0) right now. Relying
			// solely on each layer's transitionend to self-remove let covers ACCUMULATE and a previous
			// cover peek around / over the current one — especially when art changes faster than a fade
			// completes, or a fade-out transitionend never fires. Bounding to one outgoing + one incoming
			// layer keeps at most two on screen: a clean crossfade, no stack. The art URLs are
			// backend-served (art.rs) and browser-cached — nothing to revoke when a layer drops.
			let lastVisible: ArtLayer | null = null;
			for (const l of prev) if (l.loaded) lastVisible = l;
			const outgoing = lastVisible ? [{ ...lastVisible, loaded: false }] : [];
			return [...outgoing, { id, url, loaded: false }];
		});
	}, [artKey, hasSession]);

	// On unmount: cancel any pending no-art / grey-recovery timers. The art URLs are backend-served
	// (art.rs), not object URLs, so there is nothing to revoke.
	useEffect(
		() => () => {
			if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
			if (greyTimerRef.current !== null) clearTimeout(greyTimerRef.current);
		},
		[]
	);

	// Image loaded → DECODE it before fading THIS layer in, so the crossfade only starts once the
	// pixels are ready and a large cover's decode never lands a hitch on the opacity transition. (The
	// previous cover already began fading out the moment the new art was pushed — see the effect — so
	// the two cross over.) rAF so the opacity:0 start state is painted before flipping to opacity:1,
	// else an already-decoded swap collapses into an instant cut. decode() can reject (src superseded,
	// or unimplemented as in happy-dom under test) — flip anyway so a layer never sticks hidden.
	const onLayerLoad = (id: number, img: HTMLImageElement) => {
		const flip = () =>
			requestAnimationFrame(() =>
				setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, loaded: true } : l)))
			);
		const decoded = img.decode?.();
		if (decoded && typeof decoded.then === 'function') decoded.then(flip, flip);
		else flip();
	};

	// A layer finished its opacity transition. If it faded OUT (loaded:false — crossed over by a newer
	// cover, or cleared by the no-art guard), remove just itself. If it faded IN, it now fully covers
	// everything beneath, so drop those. Driven by the real transitionend (not a timer), so a cover is
	// never removed before its fade has completed, at any css duration.
	const onLayerShown = (id: number, e: ReactTransitionEvent<HTMLImageElement>) => {
		if (e.propertyName !== 'opacity') return;
		setLayers((prev) => {
			const me = prev.find((l) => l.id === id);
			if (me && !me.loaded) {
				return prev.filter((l) => l.id !== id);
			}
			return prev.filter((l) => l.id >= id);
		});
	};

	// Hide buttons the session doesn't support (caps prop); null caps = unknown → show everything.
	const can = (k: keyof MediaCaps): boolean => (caps ? caps[k] : true);

	const send = (service: string, value?: number) =>
		onControl?.({
			domain: 'media',
			service,
			// Target the session this widget shows; backend falls back to the current session.
			data: { ...(source ? { source } : {}), ...(value !== undefined ? { value } : {}) }
		});

	// stopPropagation so a button press in passive mode doesn't also hit the widget behind it.
	const act = (e: ReactMouseEvent, service: string, value?: number) => {
		e.stopPropagation();
		send(service, value);
	};

	const seekable = can('seek');
	const seekTo = (value: number): void => {
		if (!duration) return;
		send('seek', Math.min(duration, Math.max(0, value)));
	};
	const seek = (e: ReactMouseEvent<HTMLDivElement>) => {
		e.stopPropagation();
		if (!duration) return;
		const r = e.currentTarget.getBoundingClientRect();
		if (r.width <= 0) return;
		const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
		seekTo(frac * duration);
	};
	const seekWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		const value =
			event.key === 'ArrowRight' || event.key === 'ArrowUp'
				? position + 5
				: event.key === 'ArrowLeft' || event.key === 'ArrowDown'
					? position - 5
					: event.key === 'Home'
						? 0
						: event.key === 'End'
							? duration
							: null;
		if (value === null) return;
		event.preventDefault();
		event.stopPropagation();
		seekTo(value);
	};

	return (
		<div className="np-nowplaying" data-part="root" data-playing={playing}>
			{(title || layers.length > 0) && (
				<>
					{/* Crossfade stack: each art change pushes a layer that fades in over the previous one. Hidden
					    the instant the track is gone (no media) so the cover leaves WITH the title — never
					    lingering/expanding — while the adjust-during-render above clears the layers in lockstep. */}
					{hasMedia && (
						<div className="np-thumb-stack" data-part="thumb-stack">
							{layers.map((l) => (
								<img
									key={l.id}
									className="np-thumb"
									data-part="thumb"
									data-loaded={l.loaded}
									data-leaving={!!l.leaving}
									src={l.url}
									alt=""
									decoding="async"
									onLoad={(e) => onLayerLoad(l.id, e.currentTarget)}
									onTransitionEnd={(e) => onLayerShown(l.id, e)}
								/>
							))}
						</div>
					)}
					<span className="np-title" data-part="title">
						{title}
					</span>
					{artist && (
						<span className="np-artist" data-part="artist">
							{artist}
						</span>
					)}
					{/* Hidden by default (un-hide via css). Idle for players without a timeline (e.g. fb2k).
					    When the session supports seeking, click anywhere on the track to jump there. */}
					<div
						className="np-progress"
						data-part="progress"
						data-seekable={seekable}
						role={seekable ? 'slider' : undefined}
						tabIndex={seekable ? 0 : undefined}
						aria-label={seekable ? 'Track position' : undefined}
						aria-valuemin={seekable ? 0 : undefined}
						aria-valuemax={seekable ? duration : undefined}
						aria-valuenow={seekable ? position : undefined}
						aria-valuetext={seekable ? `${fmtTime(position)} of ${fmtTime(duration)}` : undefined}
						onClick={seekable ? seek : undefined}
						onKeyDown={seekable ? seekWithKeyboard : undefined}
						style={seekable ? { cursor: 'pointer' } : undefined}
					>
						<div
							className="np-progress-fill"
							data-part="progress-fill"
							style={{ width: `${progress}%` }}
						/>
					</div>
					<div className="np-times" data-part="times">
						<span className="np-position" data-part="position">
							{fmtTime(position)}
						</span>
						<span className="np-duration" data-part="duration">
							{fmtTime(duration)}
						</span>
					</div>
					<div className="np-controls" data-part="controls">
						{can('shuffle') && (
							<button
								type="button"
								className="np-shuffle"
								data-part="shuffle"
								data-active={shuffle}
								aria-label="Shuffle"
								aria-pressed={shuffle}
								onClick={(e) => act(e, 'shuffle', shuffle ? 0 : 1)}
							>
								🔀
							</button>
						)}
						{can('previous') && (
							<button
								type="button"
								className="np-prev"
								data-part="prev"
								aria-label="Previous"
								onClick={(e) => act(e, 'previous')}
							>
								⏮
							</button>
						)}
						{can('playpause') && (
							<button
								type="button"
								className="np-playpause"
								data-part="playpause"
								aria-label="Play/pause"
								onClick={(e) => act(e, 'playpause')}
							>
								{playing ? '⏸' : '▶'}
							</button>
						)}
						{can('stop') && (
							<button
								type="button"
								className="np-stop"
								data-part="stop"
								aria-label="Stop"
								onClick={(e) => act(e, 'stop')}
							>
								⏹
							</button>
						)}
						{can('next') && (
							<button
								type="button"
								className="np-next"
								data-part="next"
								aria-label="Next"
								onClick={(e) => act(e, 'next')}
							>
								⏭
							</button>
						)}
						{can('repeat') && (
							<button
								type="button"
								className="np-repeat"
								data-part="repeat"
								data-mode={repeatMode}
								aria-label={`Repeat: ${repeatMode}`}
								onClick={(e) => act(e, 'repeat', nextRepeat)}
							>
								{repeatMode === 'Track' ? '🔂' : '🔁'}
							</button>
						)}
					</div>
				</>
			)}
		</div>
	);
}
