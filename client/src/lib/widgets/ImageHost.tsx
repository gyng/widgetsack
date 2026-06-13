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
	const [url, setUrl] = useState('');

	useEffect(() => {
		const s = (src ?? '').trim();
		if (!s) {
			setUrl('');
			return;
		}
		if (isDirectUrl(s)) {
			setUrl(s);
			return;
		}
		// A bare filename → resolve against the wallpapers/ folder (best-effort; empty on failure).
		let alive = true;
		void wallpaperAssetUrl(s).then((u) => {
			if (alive) setUrl(u);
		});
		return () => {
			alive = false;
		};
	}, [src]);

	return <ImageWidget url={url} fit={fit} alt={alt} />;
}
