import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { MonitorLayout } from '../../core/layoutTree';
import type { LayoutOp } from '../ops';

// Mock the outer-ring Tauri file/asset bridge (overlay). The pure isMediaKind helper (core/background)
// stays REAL, so we verify the side-band state: async name→asset-URL resolution (cached), the
// section's file listing, and the patch/kind/clear op dispatch.
const listWallpapers = vi.fn();
const wallpaperAssetUrl = vi.fn();
vi.mock('../../overlay', () => ({
	listWallpapers: () => listWallpapers(),
	wallpaperAssetUrl: (n: string) => wallpaperAssetUrl(n)
}));

import { useBackground } from './useBackground';

const monitor = (over: Partial<MonitorLayout> = {}): MonitorLayout =>
	({ root: {}, floating: [], ...over }) as MonitorLayout;

beforeEach(() => {
	listWallpapers.mockResolvedValue(['a.png', 'b.mp4']);
	wallpaperAssetUrl.mockResolvedValue('asset://localhost/wall.png');
});
afterEach(() => vi.clearAllMocks());

describe('useBackground', () => {
	it('exposes the monitor background spec', () => {
		const m = monitor({ background: { kind: 'color', src: '#123' } });
		const { result } = renderHook(() =>
			useBackground({ studio: true, navSection: 'layouts', monitor: m, handleOp: vi.fn() })
		);
		expect(result.current.bg).toEqual({ kind: 'color', src: '#123' });
	});

	it('resolves an image/video src to an asset URL and caches it by name', async () => {
		const m = monitor({ background: { kind: 'image', src: 'wall.png' } });
		const { result } = renderHook(() =>
			useBackground({ studio: true, navSection: 'layouts', monitor: m, handleOp: vi.fn() })
		);
		expect(result.current.resolveWallpaper('wall.png')).toBe(''); // not resolved yet
		await waitFor(() =>
			expect(result.current.resolveWallpaper('wall.png')).toBe('asset://localhost/wall.png')
		);
		expect(wallpaperAssetUrl).toHaveBeenCalledTimes(1); // resolved once, then cached
	});

	it('does not resolve a color/web background (src used verbatim)', () => {
		const m = monitor({ background: { kind: 'web', src: 'https://x.test' } });
		renderHook(() =>
			useBackground({ studio: true, navSection: 'layouts', monitor: m, handleOp: vi.fn() })
		);
		expect(wallpaperAssetUrl).not.toHaveBeenCalled();
	});

	it('lists the wallpapers/ folder only when the Background section is open in the studio', async () => {
		const { result, rerender } = renderHook(
			(props: { studio: boolean; section: string }) =>
				useBackground({
					studio: props.studio,
					navSection: props.section as never,
					monitor: monitor(),
					handleOp: vi.fn()
				}),
			{ initialProps: { studio: true, section: 'widgets' } }
		);
		expect(listWallpapers).not.toHaveBeenCalled(); // wrong section
		rerender({ studio: true, section: 'background' });
		await waitFor(() => expect(result.current.wallpaperFiles).toEqual(['a.png', 'b.mp4']));

		// refreshWallpapers re-reads the folder on demand.
		listWallpapers.mockResolvedValue(['only.png']);
		await act(async () => {
			result.current.refreshWallpapers();
		});
		await waitFor(() => expect(result.current.wallpaperFiles).toEqual(['only.png']));
	});

	it('does not list wallpapers on the overlay (studio=false)', () => {
		renderHook(() =>
			useBackground({
				studio: false,
				navSection: 'background',
				monitor: monitor(),
				handleOp: vi.fn()
			})
		);
		expect(listWallpapers).not.toHaveBeenCalled();
	});

	it('patchBg merges into the existing spec via setBackground', () => {
		const handleOp = vi.fn<(op: LayoutOp) => void>();
		const m = monitor({ background: { kind: 'image', src: 'wall.png' } });
		const { result } = renderHook(() =>
			useBackground({ studio: true, navSection: 'background', monitor: m, handleOp })
		);
		act(() => result.current.patchBg({ opacity: 0.5 }));
		expect(handleOp).toHaveBeenCalledWith({
			op: 'setBackground',
			spec: { kind: 'image', src: 'wall.png', opacity: 0.5 }
		});
	});

	it('patchBg starts from a default color base when there is no background yet', () => {
		const handleOp = vi.fn<(op: LayoutOp) => void>();
		const { result } = renderHook(() =>
			useBackground({ studio: true, navSection: 'background', monitor: monitor(), handleOp })
		);
		act(() => result.current.patchBg({ src: '#abc' }));
		expect(handleOp).toHaveBeenCalledWith({
			op: 'setBackground',
			spec: { kind: 'color', src: '#abc' }
		});
	});

	it('setBgKind keeps src when the kind is unchanged, else resets it', () => {
		const handleOp = vi.fn<(op: LayoutOp) => void>();
		const m = monitor({ background: { kind: 'image', src: 'wall.png' } });
		const { result } = renderHook(() =>
			useBackground({ studio: true, navSection: 'background', monitor: m, handleOp })
		);
		act(() => result.current.setBgKind('image')); // same kind → keep src
		expect(handleOp).toHaveBeenLastCalledWith({
			op: 'setBackground',
			spec: { kind: 'image', src: 'wall.png' }
		});
		act(() => result.current.setBgKind('color')); // different kind → reset src
		expect(handleOp).toHaveBeenLastCalledWith({
			op: 'setBackground',
			spec: { kind: 'color', src: '' }
		});
	});

	it('clearBg dispatches setBackground with an undefined spec', () => {
		const handleOp = vi.fn<(op: LayoutOp) => void>();
		const { result } = renderHook(() =>
			useBackground({ studio: true, navSection: 'background', monitor: monitor(), handleOp })
		);
		act(() => result.current.clearBg());
		expect(handleOp).toHaveBeenCalledWith({ op: 'setBackground', spec: undefined });
	});
});
