// Bespoke container for the HA media_player widget: resolves the album-art URL as a side effect
// (entity_picture → ha_media_art → art-scheme URL the webview can <img>-load), then renders the
// prop-only HaMediaPlayer meter. Registered as ha.media_player's component — a documented Host
// exception (AGENTS.md §6) so the meter itself stays pure/Tauri-free. Re-fetches only when the
// entity_picture changes (HA varies it by a cache key per track), so it's one fetch per track.
import { useEffect, useState } from 'react';
import HaMediaPlayer from '../meters/HaMediaPlayer';
import type { ControlEvent } from '../meterProps';
import { haMediaArt } from './ha-commands';

type HaState = { attributes?: Record<string, unknown> };

type Props = {
	value?: unknown;
	label?: string;
	onControl?: (e: ControlEvent) => void;
	showTransport?: boolean;
	showVolume?: boolean;
};

export default function HaMediaPlayerHost(props: Props) {
	const pic =
		((props.value as HaState | null)?.attributes?.entity_picture as string | undefined) ?? '';
	// Tagged with the picture it was decoded for, so a track change never shows the previous cover.
	const [decoded, setDecoded] = useState<{ pic: string; url?: string } | undefined>(undefined);

	useEffect(() => {
		if (!pic) return;
		let cancelled = false;
		haMediaArt(pic)
			.then((url) => {
				if (!cancelled) setDecoded({ pic, url });
			})
			.catch(() => {
				if (!cancelled) setDecoded({ pic });
			});
		return () => {
			cancelled = true;
		};
	}, [pic]);

	// Only the url decoded for the CURRENT picture: no picture, or a new track whose art is still
	// loading, shows no art rather than lingering on a previous cover. Derived in render (no
	// synchronous reset in the effect).
	const art = decoded?.pic === pic ? decoded.url : undefined;

	return <HaMediaPlayer {...props} art={art} />;
}
