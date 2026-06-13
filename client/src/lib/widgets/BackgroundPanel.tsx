// Background section (extracted from Canvas): per-monitor full-screen effect behind the widgets —
// kind picker (color / image / video / web), the wallpapers/ file list, fit/mute/loop/opacity/dim.
// Purely a panel: the spec + handlers live in Canvas (canvas/useBackground) and arrive as props;
// the only module call it makes itself is the stateless open-folder helper. Lazy-loaded like the
// other studio panels (Canvas's lazy() block), so the overlay never fetches it.
import { useState } from 'react';
import { BACKGROUND_FITS, BACKGROUND_KINDS, isMediaKind } from '../core/background';
import type { BackgroundKind, BackgroundSpec } from '../core/layoutTree';
import type { Tokens } from '../core/tokens';
import { deriveTokens } from '../core/palette';
import { sampleImagePixels } from './canvas/wallpaperSampler';
import { openWallpapersDir } from '../overlay';

type Props = {
	bg: BackgroundSpec | undefined;
	wallpaperFiles: string[];
	refreshWallpapers: () => void;
	patchBg: (patch: Partial<BackgroundSpec>) => void;
	setBgKind: (kind: BackgroundKind) => void;
	clearBg: () => void;
	// Wallpaper auto-theme (issue #15): resolve the current image to a URL, apply the derived tokens.
	resolveWallpaper?: (name: string) => string;
	onAutoTheme?: (tokens: Tokens) => void;
	onClearTokens?: () => void;
};

export default function BackgroundPanel({
	bg,
	wallpaperFiles,
	refreshWallpapers,
	patchBg,
	setBgKind,
	clearBg,
	resolveWallpaper,
	onAutoTheme,
	onClearTokens
}: Props) {
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<'idle' | 'done' | 'fail'>('idle');

	const autoTheme = async (): Promise<void> => {
		if (!bg?.src || !resolveWallpaper || !onAutoTheme) return;
		setBusy(true);
		setStatus('idle');
		try {
			const pixels = await sampleImagePixels(resolveWallpaper(bg.src));
			const tokens = deriveTokens(pixels);
			if (Object.keys(tokens).length === 0) {
				setStatus('fail');
				return;
			}
			onAutoTheme(tokens);
			setStatus('done');
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="rail-panel bg-panel">
			<div className="rp-hd">Background</div>
			<div className="rp-stub">
				A full-screen effect behind this monitor’s widgets. It shows on the desktop when the overlay
				sits below windows (Settings → overlay layer); the studio always previews it.
			</div>

			<label className="bg-field">
				<span>Type</span>
				<select
					value={bg?.kind ?? 'none'}
					onChange={(e) => {
						const v = e.currentTarget.value;
						if (v === 'none') clearBg();
						else setBgKind(v as BackgroundKind);
					}}
				>
					<option value="none">None</option>
					{BACKGROUND_KINDS.map((k) => (
						<option key={k} value={k}>
							{k}
						</option>
					))}
				</select>
			</label>

			{bg?.kind === 'color' && (
				<label className="bg-field">
					<span>Colour</span>
					<input
						type="color"
						value={/^#[0-9a-fA-F]{6}$/.test(bg.src ?? '') ? bg.src : '#0b0b0e'}
						onChange={(e) => patchBg({ src: e.currentTarget.value })}
					/>
				</label>
			)}

			{bg?.kind === 'web' && (
				<label className="bg-field">
					<span>URL</span>
					<input
						type="text"
						defaultValue={bg.src ?? ''}
						key={bg.src ?? ''}
						placeholder="https://…  (a web / WebGL wallpaper)"
						onBlur={(e) => patchBg({ src: e.currentTarget.value.trim() })}
					/>
				</label>
			)}

			{bg && isMediaKind(bg.kind) && (
				<>
					<div className="bg-files-hd">
						<span className="rp-sub">Files in wallpapers/</span>
						<span className="bg-files-ops">
							<button type="button" title="Refresh the list" onClick={refreshWallpapers}>
								↻
							</button>
							<button
								type="button"
								title="Open the wallpapers folder — drop image/video files in here"
								onClick={() => openWallpapersDir()}
							>
								⊞ Folder
							</button>
						</span>
					</div>
					{wallpaperFiles.length ? (
						<div className="bg-files">
							{wallpaperFiles.map((f) => (
								<button
									key={f}
									type="button"
									className={['bg-file', bg.src === f && 'cur'].filter(Boolean).join(' ')}
									title={f}
									onClick={() => patchBg({ src: f })}
								>
									{f}
								</button>
							))}
						</div>
					) : (
						<div className="rp-stub">
							No files yet — click ⊞ Folder and drop an image or video in.
						</div>
					)}
				</>
			)}

			{bg && isMediaKind(bg.kind) && (
				<label className="bg-field">
					<span>Fit</span>
					<select
						value={bg.fit ?? 'cover'}
						onChange={(e) => patchBg({ fit: e.currentTarget.value as BackgroundSpec['fit'] })}
					>
						{BACKGROUND_FITS.map((f) => (
							<option key={f} value={f}>
								{f}
							</option>
						))}
					</select>
				</label>
			)}

			{bg?.kind === 'image' && bg.src && resolveWallpaper && onAutoTheme && (
				<>
					<div className="bg-files-hd">
						<span className="rp-sub">Auto theme</span>
					</div>
					<div className="rp-stub">
						Derive readable widget colours from this wallpaper — an accent from its dominant tone,
						with text that flips light/dark to stay legible over it.
					</div>
					<div className="bg-files-ops">
						<button type="button" onClick={autoTheme} disabled={busy} aria-busy={busy}>
							{busy ? 'Reading…' : '🎨 From wallpaper'}
						</button>
						{onClearTokens && (
							<button
								type="button"
								title="Clear the auto / manual colour overrides"
								onClick={() => {
									onClearTokens();
									setStatus('idle');
								}}
							>
								Reset colours
							</button>
						)}
					</div>
					{status === 'done' && <div className="rp-stub">Applied — the widgets recolour live.</div>}
					{status === 'fail' && <div className="rp-stub">Couldn’t read the image’s colours.</div>}
				</>
			)}

			{bg?.kind === 'video' && (
				<div className="bg-checks">
					<label className="bg-check">
						<input
							type="checkbox"
							checked={bg.mute ?? true}
							onChange={(e) => patchBg({ mute: e.currentTarget.checked })}
						/>
						muted
					</label>
					<label className="bg-check">
						<input
							type="checkbox"
							checked={bg.loop ?? true}
							onChange={(e) => patchBg({ loop: e.currentTarget.checked })}
						/>
						loop
					</label>
				</div>
			)}

			{bg && (
				<>
					<label className="bg-field bg-range">
						<span>Opacity {Math.round((bg.opacity ?? 1) * 100)}%</span>
						<input
							type="range"
							min={0}
							max={1}
							step={0.05}
							value={bg.opacity ?? 1}
							onChange={(e) => patchBg({ opacity: Number(e.currentTarget.value) })}
						/>
					</label>
					<label className="bg-field bg-range">
						<span>Dim {Math.round((bg.dim ?? 0) * 100)}%</span>
						<input
							type="range"
							min={0}
							max={1}
							step={0.05}
							value={bg.dim ?? 0}
							onChange={(e) => patchBg({ dim: Number(e.currentTarget.value) })}
						/>
					</label>
					<button type="button" className="bg-clear" onClick={clearBg}>
						Remove background
					</button>
				</>
			)}
		</div>
	);
}
