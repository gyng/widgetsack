// Shared "auto theme from wallpaper" action (issue #15) — used by BOTH the Background panel and the
// Themes section so there's one implementation. Samples the current IMAGE wallpaper, derives a
// readable Tokens override (core/palette.ts), and applies it via the caller's apply callback (which
// dispatches the setTokens editor op). `canAuto` is false unless there's an image wallpaper to read.
import { useCallback, useState } from 'react';
import type { BackgroundSpec } from '../../core/layoutTree';
import type { Tokens } from '../../core/tokens';
import { deriveTokens } from '../../core/palette';
import { sampleImagePixels } from './wallpaperSampler';

export type AutoThemeStatus = 'idle' | 'done' | 'fail';

export type AutoTheme = {
	/** True when there's an image wallpaper with a file to derive from. */
	canAuto: boolean;
	busy: boolean;
	status: AutoThemeStatus;
	/** Sample the wallpaper → derive → apply. No-op when `canAuto` is false. */
	run: () => Promise<void>;
	resetStatus: () => void;
};

export function useAutoTheme(opts: {
	bg: BackgroundSpec | undefined;
	resolveWallpaper: (name: string) => string;
	applyTokens: (tokens: Tokens) => void;
}): AutoTheme {
	const { bg, resolveWallpaper, applyTokens } = opts;
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<AutoThemeStatus>('idle');
	const canAuto = Boolean(bg && bg.kind === 'image' && bg.src);

	const run = useCallback(async (): Promise<void> => {
		if (!bg || bg.kind !== 'image' || !bg.src) return;
		setBusy(true);
		setStatus('idle');
		try {
			const pixels = await sampleImagePixels(resolveWallpaper(bg.src));
			const tokens = deriveTokens(pixels);
			if (Object.keys(tokens).length === 0) {
				setStatus('fail');
				return;
			}
			applyTokens(tokens);
			setStatus('done');
		} finally {
			setBusy(false);
		}
	}, [bg, resolveWallpaper, applyTokens]);

	const resetStatus = useCallback(() => setStatus('idle'), []);
	return { canAuto, busy, status, run, resetStatus };
}
