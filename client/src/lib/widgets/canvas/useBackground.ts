// Background (wallpaper) layer state + handlers (extracted from Canvas). The spec itself lives on
// the monitor (editor model) and rides the normal commit/undo path via handleOp('setBackground');
// this hook owns the side-band state around it: resolving a wallpapers/ filename to an asset URL
// (async, cached by name), the Background section's file list, and the patch/kind/clear helpers.
import { useCallback, useEffect, useState } from 'react';
import { isMediaKind } from '../../core/background';
import type { BackgroundKind, BackgroundSpec, MonitorLayout } from '../../core/layoutTree';
import { listWallpapers, wallpaperAssetUrl } from '../../overlay';
import type { LayoutOp } from '../ops';
import type { SectionId } from './studioSections';

type Deps = {
	studio: boolean;
	navSection: SectionId;
	monitor: MonitorLayout;
	handleOp: (op: LayoutOp) => void;
};

export type Background = {
	/** The current monitor's background spec (undefined = none). */
	bg: BackgroundSpec | undefined;
	/** wallpapers/ filename → asset URL ('' until resolved). Color/web kinds use `src` verbatim. */
	resolveWallpaper: (name: string) => string;
	/** The wallpapers/ folder contents (the Background section's image/video picker). */
	wallpaperFiles: string[];
	refreshWallpapers: () => Promise<void>;
	patchBg: (patch: Partial<BackgroundSpec>) => void;
	setBgKind: (kind: BackgroundKind) => void;
	clearBg: () => void;
};

export function useBackground({ studio, navSection, monitor, handleOp }: Deps): Background {
	// An image/video background's `src` is a wallpapers/ filename; resolve it to an asset URL
	// (async, cached by name). Color/web kinds use `src` verbatim.
	const bg = monitor.background;
	const bgMediaName = bg && isMediaKind(bg.kind) ? bg.src : undefined;
	const [wallpaperUrls, setWallpaperUrls] = useState<Record<string, string>>({});
	useEffect(() => {
		if (!bgMediaName || wallpaperUrls[bgMediaName]) return;
		let cancelled = false;
		wallpaperAssetUrl(bgMediaName).then((url) => {
			if (!cancelled && url) setWallpaperUrls((m) => ({ ...m, [bgMediaName]: url }));
		});
		return () => {
			cancelled = true;
		};
	}, [bgMediaName, wallpaperUrls]);
	const resolveWallpaper = useCallback(
		(name: string) => wallpaperUrls[name] ?? '',
		[wallpaperUrls]
	);

	// The wallpapers/ folder contents (the Background section's image/video picker). Refreshed when
	// the section opens — so a file dropped into the folder appears after a re-open or ↻.
	const [wallpaperFiles, setWallpaperFiles] = useState<string[]>([]);
	const refreshWallpapers = useCallback(async () => {
		setWallpaperFiles(await listWallpapers());
	}, []);
	useEffect(() => {
		if (studio && navSection === 'background') void refreshWallpapers();
	}, [studio, navSection, refreshWallpapers]);
	// Merge a patch into the current background spec (creating a default 'color' base if none yet),
	// or switch kind (which resets `src`, since a colour, a filename and a URL aren't interchangeable).
	const patchBg = useCallback(
		(patch: Partial<BackgroundSpec>) => {
			const base: BackgroundSpec = bg ?? { kind: 'color' };
			handleOp({ op: 'setBackground', spec: { ...base, ...patch } });
		},
		[bg, handleOp]
	);
	const setBgKind = useCallback(
		(kind: BackgroundKind) => {
			handleOp({ op: 'setBackground', spec: { kind, src: bg?.kind === kind ? bg.src : '' } });
		},
		[bg, handleOp]
	);
	const clearBg = useCallback(() => handleOp({ op: 'setBackground', spec: undefined }), [handleOp]);

	return { bg, resolveWallpaper, wallpaperFiles, refreshWallpapers, patchBg, setBgKind, clearBg };
}
