import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor, cleanup, act } from '@testing-library/react';

// Mock the Tauri asset resolver (outer ring). The pure direct-URL classifier (core/imageSrc) is left
// REAL — it's already unit-tested — so we verify the host routes each src kind correctly.
const wallpaperAssetUrl = vi.fn();
vi.mock('../overlay', () => ({ wallpaperAssetUrl: (n: string) => wallpaperAssetUrl(n) }));

import ImageHost from './ImageHost';

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function imgSrc(container: HTMLElement): string | null {
	return container.querySelector('img')?.getAttribute('src') ?? null;
}

describe('ImageHost', () => {
	it('uses a direct URL verbatim and never hits the asset resolver', async () => {
		const { container } = render(<ImageHost src="https://example.com/a.png" />);
		await waitFor(() => expect(imgSrc(container)).toBe('https://example.com/a.png'));
		expect(wallpaperAssetUrl).not.toHaveBeenCalled();
	});

	it('resolves a bare filename against the wallpapers/ folder', async () => {
		wallpaperAssetUrl.mockResolvedValue('asset://localhost/cat.png');
		const { container } = render(<ImageHost src="  cat.png  " fit="cover" alt="a cat" />);
		await waitFor(() => expect(imgSrc(container)).toBe('asset://localhost/cat.png'));
		expect(wallpaperAssetUrl).toHaveBeenCalledWith('cat.png'); // trimmed
		const img = container.querySelector('img')!;
		expect(img.getAttribute('alt')).toBe('a cat');
	});

	it('renders the empty state for a blank/whitespace src (no resolve)', () => {
		const { container } = render(<ImageHost src="   " />);
		expect(container.querySelector('[data-empty="true"]')).toBeTruthy();
		expect(imgSrc(container)).toBeNull();
		expect(wallpaperAssetUrl).not.toHaveBeenCalled();
	});

	it('treats a missing src as blank (the default empty string)', () => {
		const { container } = render(<ImageHost />);
		expect(container.querySelector('[data-empty="true"]')).toBeTruthy();
		expect(wallpaperAssetUrl).not.toHaveBeenCalled();
	});

	it('defends against a null src (the ?? "" guard)', () => {
		// A malformed layout could feed a null src past the default param; the guard coalesces it.
		const { container } = render(<ImageHost src={null as unknown as string} />);
		expect(container.querySelector('[data-empty="true"]')).toBeTruthy();
		expect(wallpaperAssetUrl).not.toHaveBeenCalled();
	});

	it('ignores a stale resolve after the src changes (cleanup guards the late setUrl)', async () => {
		let resolveFirst!: (u: string) => void;
		wallpaperAssetUrl
			.mockImplementationOnce(() => new Promise<string>((r) => (resolveFirst = r)))
			.mockResolvedValueOnce('asset://localhost/second.png');
		const { container, rerender } = render(<ImageHost src="first.png" />);
		rerender(<ImageHost src="second.png" />); // first effect cleaned up before it resolves
		await waitFor(() => expect(imgSrc(container)).toBe('asset://localhost/second.png'));
		await act(async () => {
			resolveFirst('asset://localhost/first.png'); // late: must NOT overwrite
		});
		expect(imgSrc(container)).toBe('asset://localhost/second.png');
	});
});
