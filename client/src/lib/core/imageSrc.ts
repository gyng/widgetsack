// Pure helpers for the Image widget. No React/Tauri — unit-tested. An image source is either a direct
// URL (used as-is) or a bare filename resolved against the app's wallpapers/ folder by the host.
// "Direct" means "has a scheme / is absolute" — whether it LOADS is the CSP's call (tauri.conf.json
// `img-src`: https/data/blob/asset only; a plain http:// image is blocked by the webview).

const DIRECT = /^(https?:|data:|blob:|asset:|file:|tauri:|\/\/?|\\\\)/i;

/** True when `src` is a usable URL as-is (has a scheme, or is an absolute/UNC path) — vs a bare
 * wallpapers/ filename that needs resolving. Pure. */
export function isDirectUrl(src: string): boolean {
	return DIRECT.test(src.trim());
}

export type ImageFit = 'contain' | 'cover' | 'fill' | 'none';

/** Normalise the `fit` config to a valid CSS object-fit (default contain). Pure. */
export function imageFit(fit: string | undefined): ImageFit {
	return fit === 'cover' || fit === 'fill' || fit === 'none' ? fit : 'contain';
}
