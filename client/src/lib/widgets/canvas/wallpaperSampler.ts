// Outer-ring adapter for the wallpaper auto-theme (issue #15): load the current wallpaper image and
// sample its pixels into RGB triples for core/palette.ts. DOM/canvas lives here (not in core). The
// Tauri asset:// wallpaper URLs are CORS-enabled, so crossOrigin lets getImageData read them untainted;
// any failure (decode error / tainted canvas) degrades to [] so the caller just reports "couldn't read".
import type { RGB } from '../../core/palette';

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.onload = () => resolve(img);
		img.onerror = reject;
		img.src = src;
	});
}

/** Load `url` and return its pixels (downscaled so the longest side is ≤ `maxDim`), skipping
 * transparent ones. `[]` on any failure. */
export async function sampleImagePixels(url: string, maxDim = 72): Promise<RGB[]> {
	let img: HTMLImageElement;
	try {
		img = await loadImage(url);
	} catch {
		return [];
	}
	const w = img.naturalWidth || img.width;
	const h = img.naturalHeight || img.height;
	if (!w || !h) return [];
	const scale = Math.min(1, maxDim / Math.max(w, h));
	const cw = Math.max(1, Math.round(w * scale));
	const ch = Math.max(1, Math.round(h * scale));
	const canvas = document.createElement('canvas');
	canvas.width = cw;
	canvas.height = ch;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return [];
	ctx.drawImage(img, 0, 0, cw, ch);
	let data: Uint8ClampedArray;
	try {
		data = ctx.getImageData(0, 0, cw, ch).data;
	} catch {
		return []; // tainted canvas (a non-CORS source)
	}
	const out: RGB[] = [];
	for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] < 128) continue;
		out.push([data[i], data[i + 1], data[i + 2]]);
	}
	return out;
}
