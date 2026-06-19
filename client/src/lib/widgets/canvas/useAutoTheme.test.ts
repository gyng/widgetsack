import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { BackgroundSpec } from '../../core/layoutTree';
import type { Tokens } from '../../core/tokens';

// Mock the DOM/canvas pixel sampler (outer ring; happy-dom can't draw). The colour math
// (core/palette deriveTokens) stays REAL so the hook's sample→derive→apply→status flow is exercised.
const sampleImagePixels = vi.fn();
vi.mock('./wallpaperSampler', () => ({
	sampleImagePixels: (url: string) => sampleImagePixels(url)
}));

import { useAutoTheme } from './useAutoTheme';

afterEach(() => vi.clearAllMocks());

const imageBg: BackgroundSpec = { kind: 'image', src: 'wall.png' };
const resolveWallpaper = (n: string) => `asset://localhost/${n}`;

describe('useAutoTheme', () => {
	it('canAuto is false without an image wallpaper, and run() is a no-op', async () => {
		const applyTokens = vi.fn();
		const { result } = renderHook(() =>
			useAutoTheme({ bg: { kind: 'color', src: '#000' }, resolveWallpaper, applyTokens })
		);
		expect(result.current.canAuto).toBe(false);
		await act(async () => {
			await result.current.run();
		});
		expect(sampleImagePixels).not.toHaveBeenCalled();
		expect(applyTokens).not.toHaveBeenCalled();
		expect(result.current.busy).toBe(false);
	});

	it('canAuto is false for an image with no src', () => {
		const { result } = renderHook(() =>
			useAutoTheme({ bg: { kind: 'image', src: '' }, resolveWallpaper, applyTokens: vi.fn() })
		);
		expect(result.current.canAuto).toBe(false);
	});

	it('canAuto is true and run() samples → derives → applies, ending in done', async () => {
		// A solid mid-grey image derives a non-empty Tokens map.
		sampleImagePixels.mockResolvedValue(Array.from({ length: 50 }, () => [120, 130, 140]));
		const applyTokens = vi.fn();
		const { result } = renderHook(() =>
			useAutoTheme({ bg: imageBg, resolveWallpaper, applyTokens })
		);
		expect(result.current.canAuto).toBe(true);

		await act(async () => {
			await result.current.run();
		});
		expect(sampleImagePixels).toHaveBeenCalledWith('asset://localhost/wall.png');
		expect(applyTokens).toHaveBeenCalledOnce();
		expect(Object.keys(applyTokens.mock.calls[0]![0] as Tokens).length).toBeGreaterThan(0);
		expect(result.current.status).toBe('done');
		expect(result.current.busy).toBe(false);
	});

	it('run() reports fail (and does not apply) when no pixels could be sampled', async () => {
		sampleImagePixels.mockResolvedValue([]); // tainted/failed decode → empty Tokens
		const applyTokens = vi.fn();
		const { result } = renderHook(() =>
			useAutoTheme({ bg: imageBg, resolveWallpaper, applyTokens })
		);
		await act(async () => {
			await result.current.run();
		});
		expect(applyTokens).not.toHaveBeenCalled();
		expect(result.current.status).toBe('fail');
		expect(result.current.busy).toBe(false);
	});

	it('clears busy even when sampling throws (finally)', async () => {
		sampleImagePixels.mockRejectedValue(new Error('decode error'));
		const { result } = renderHook(() =>
			useAutoTheme({ bg: imageBg, resolveWallpaper, applyTokens: vi.fn() })
		);
		await act(async () => {
			await expect(result.current.run()).rejects.toThrow('decode error');
		});
		expect(result.current.busy).toBe(false);
	});

	it('resetStatus returns the status to idle', async () => {
		sampleImagePixels.mockResolvedValue([]);
		const { result } = renderHook(() =>
			useAutoTheme({ bg: imageBg, resolveWallpaper, applyTokens: vi.fn() })
		);
		await act(async () => {
			await result.current.run();
		});
		expect(result.current.status).toBe('fail');
		act(() => result.current.resetStatus());
		expect(result.current.status).toBe('idle');
	});
});
