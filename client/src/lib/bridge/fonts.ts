import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { COMMANDS } from './contract';

type SystemFont = { name: string; fontName: string; path: string };
const ensuredFonts = new Set<string>();
const normFont = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Make an installed font usable in the webview by `@font-face`-ing its file. Chromium's sandbox
 * won't render a PER-USER-installed font by name, so we ask the backend (fontdb) for the file path
 * and load it via the asset protocol. Matches the family OR PostScript name, normalized (so a
 * spaced family resolves its spaceless PostScript face). Idempotent per window. */
export async function ensureFont(family: string): Promise<void> {
	if (ensuredFonts.has(family)) return;
	ensuredFonts.add(family);
	try {
		const want = normFont(family);
		const fonts = await invoke<SystemFont[]>(COMMANDS.systemFonts);
		const match = fonts.find((f) => normFont(f.name) === want || normFont(f.fontName) === want);
		if (!match) {
			console.warn(`ensureFont: "${family}" not found among installed fonts`);
			ensuredFonts.delete(family); // allow a retry later
			return;
		}
		const fmt = match.path.toLowerCase().endsWith('.otf') ? 'opentype' : 'truetype';
		const style = document.createElement('style');
		style.dataset.font = family;
		style.textContent = `@font-face { font-family: '${family}'; src: url('${convertFileSrc(
			match.path
		)}') format('${fmt}'); font-display: swap; }`;
		document.head.appendChild(style);
	} catch (err) {
		console.warn('ensureFont failed', err);
		ensuredFonts.delete(family);
	}
}
