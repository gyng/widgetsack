// Container (AGENTS.md §6) for the Image widget: resolves the configured source to a URL the webview
// can render, then feeds the presentational ImageWidget. A direct URL (https / data / asset / …) is
// used as-is; a bare filename is resolved against the app's wallpapers/ folder via the asset protocol
// (reusing overlay.ts's wallpaperAssetUrl). Registered as `image` in registry.tsx.
import { useEffect, useState } from 'react';
import ImageWidget from './meters/ImageWidget';
import { isDirectUrl } from '../core/imageSrc';
import { wallpaperAssetUrl } from '../overlay';

type Props = { src?: string; fit?: string; alt?: string };

export default function ImageHost({ src = '', fit = 'contain', alt = '' }: Props) {
	const s = (src ?? '').trim();
	// The synchronous cases (empty, or a direct URL) resolve during render; `null` means the source is
	// a bare filename that needs the async wallpapers/ lookup below.
	const direct = !s ? '' : isDirectUrl(s) ? s : null;
	const [resolved, setResolved] = useState('');

	useEffect(() => {
		if (direct !== null) return; // handled during render
		// A bare filename → resolve against the wallpapers/ folder (best-effort; empty on failure).
		let alive = true;
		void wallpaperAssetUrl(s).then((u) => {
			if (alive) setResolved(u);
		});
		return () => {
			alive = false;
		};
	}, [direct, s]);

	return <ImageWidget url={direct ?? resolved} fit={fit} alt={alt} />;
}
