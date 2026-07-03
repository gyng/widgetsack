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
	const [decoded, setDecoded] = useState<string | undefined>(undefined);

	useEffect(() => {
		if (!pic) return;
		let cancelled = false;
		haMediaArt(pic)
			.then((url) => {
				if (!cancelled) setDecoded(url);
			})
			.catch(() => {
				if (!cancelled) setDecoded(undefined);
			});
		return () => {
			cancelled = true;
		};
	}, [pic]);

	// No picture → no art (don't linger on a previous track's cover); otherwise the async-decoded url.
	// Deriving `art` in render replaces a synchronous `setArt(undefined)` in the effect.
	const art = pic ? decoded : undefined;

	return <HaMediaPlayer {...props} art={art} />;
}
