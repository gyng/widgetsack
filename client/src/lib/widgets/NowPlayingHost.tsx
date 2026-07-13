// Container for the `nowplaying` widget type (AGENTS.md §6): owns the wiring the meter must not —
// boots the GSMTC media feed (idempotent), subscribes to mediaStore, picks the active session
// (ignore filter + source-priority sort, same as the np.* sensor source), and fetches the session's
// transport capabilities — then renders the pure meters/NowPlaying meter with plain props.
// Registered as the type's component in plugins/now-playing.ts; the `onControl` upward-event
// pattern is unchanged (WidgetHost adds the widget identity, Canvas makes the Tauri call).
import { useEffect, useState } from 'react';
import { mediaStore } from '../../stores/stores';
import { useStore } from '../../stores/createStore';
import { filterIgnored, sortSessionsByPriority } from '../components/NowPlaying/priority';
import {
	getMediaCapabilities,
	startMediaSource,
	type MediaCaps
} from '../components/NowPlaying/source';
import NowPlaying from './meters/NowPlaying';
import type { ControlEvent } from './meterProps';

type Props = {
	label?: string;
	onControl?: (e: ControlEvent) => void;
};

export default function NowPlayingHost({ label, onControl }: Props) {
	useEffect(() => {
		void startMediaSource();
	}, []);

	const state = useStore(mediaStore);
	const session = sortSessionsByPriority(
		filterIgnored(state.sessions, state.ignoreList),
		state.sourcePriority
	).at(0);
	const source = session?.source;
	const title = session?.last_media_update?.Media?.[0]?.media?.title ?? '';

	// Which controls the active session supports. null = unknown (no backend / not yet fetched) —
	// the meter then shows every button rather than hiding the basics.
	const [caps, setCaps] = useState<MediaCaps | null>(null);
	useEffect(() => {
		let alive = true;
		getMediaCapabilities(source).then((c) => {
			if (alive) setCaps(c);
		});
		return () => {
			alive = false;
		};
		// Re-query when the session or track changes (next/prev availability tracks the queue).
	}, [source, title]);

	return <NowPlaying session={session} caps={caps} label={label} onControl={onControl} />;
}
