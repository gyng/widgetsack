import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { COMMANDS } from './contract';

// ---- wallpapers: media files for the per-monitor background layer (in a fixed `wallpapers/` folder)

/** The media filenames available in the app-config `wallpapers/` folder (the Background picker). */
export async function listWallpapers(): Promise<string[]> {
	try {
		return await invoke<string[]>(COMMANDS.listWallpapers);
	} catch (err) {
		console.warn('list_wallpapers failed', err);
		return [];
	}
}

/** Resolve a wallpaper filename to an asset URL the webview can render (image/video `src`). */
export async function wallpaperAssetUrl(name: string): Promise<string> {
	try {
		const path = await invoke<string>(COMMANDS.wallpaperPath, { name });
		return convertFileSrc(path);
	} catch (err) {
		console.warn('wallpaper_path failed', err);
		return '';
	}
}

/** Open the `wallpapers/` folder in Explorer so the user can drop media files in. */
export async function openWallpapersDir(): Promise<void> {
	try {
		await invoke(COMMANDS.openWallpapersDir);
	} catch (err) {
		console.warn('open_wallpapers_dir failed', err);
	}
}
