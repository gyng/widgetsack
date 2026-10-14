import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { COMMANDS } from './contract';
import { fontFaceCss, matchFontFaces, type SystemFont } from '../core/fontFace';

const ensuredFonts = new Set<string>();
// A family that matched no installed face, with when we looked: styleCss changes re-ask for every
// family each time, and re-fetching the full font list per change for a typo'd/fallback name is
// wasteful. Retried after the backend's own cache window (a font installed mid-session).
const missedAt = new Map<string, number>();
const MISS_RETRY_MS = 5 * 60 * 1000;
let fontList: { at: number; fonts: Promise<SystemFont[]> } | null = null;

function systemFonts(now: number): Promise<SystemFont[]> {
	if (!fontList || now - fontList.at >= MISS_RETRY_MS) {
		const fonts = invoke<SystemFont[]>(COMMANDS.systemFonts);
		fontList = { at: now, fonts };
		fonts.catch(() => {
			if (fontList?.fonts === fonts) fontList = null; // let a later call retry
		});
	}
	return fontList.fonts;
}

/** Make an installed font usable in the webview. Chromium's sandbox won't render a PER-USER-installed
 * font by name, so we ask the backend (fontdb) for its faces and `@font-face` each per-user face's file
 * via the asset protocol, with its own weight/style/stretch (core/fontFace). Machine-wide fonts are
 * left alone — Chromium already renders those by name with every weight. Idempotent per window. */
export async function ensureFont(family: string): Promise<void> {
	if (ensuredFonts.has(family)) return;
	const now = Date.now();
	const missed = missedAt.get(family);
	if (missed !== undefined && now - missed < MISS_RETRY_MS) return;
	ensuredFonts.add(family);
	try {
		const faces = matchFontFaces(await systemFonts(now), family);
		if (!faces.length) {
			console.warn(`ensureFont: "${family}" not found among installed fonts`);
			ensuredFonts.delete(family);
			missedAt.set(family, now);
			return;
		}
		missedAt.delete(family);
		const css = fontFaceCss(family, faces, convertFileSrc);
		if (!css) return;
		const style = document.createElement('style');
		style.dataset.font = family;
		style.textContent = css;
		document.head.appendChild(style);
	} catch (err) {
		console.warn('ensureFont failed', err);
		ensuredFonts.delete(family);
	}
}
