import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

// Stub the HA Tauri command adapter (no backend in tests): the host resolves entity_picture →
// art-scheme URL through haMediaArt and feeds it to the prop-only meter. A deferred promise lets us
// drive when (and whether) the fetch resolves, so we can exercise the cancelled-after-unmount guard.
const { haMediaArt } = vi.hoisted(() => ({
	haMediaArt: vi.fn<(entity: string) => Promise<string>>()
}));
vi.mock('./ha-commands', () => ({ haMediaArt }));

import HaMediaPlayerHost from './HaMediaPlayerHost';

const withPicture = (entity_picture?: string): unknown =>
	entity_picture === undefined
		? { attributes: {} }
		: { attributes: { entity_picture, friendly_name: 'Living Room' }, state: 'playing' };

beforeEach(() => {
	haMediaArt.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('HaMediaPlayerHost (container wiring)', () => {
	it('resolves entity_picture through haMediaArt and passes the art URL to the meter', async () => {
		haMediaArt.mockResolvedValue('art://abc');
		const { container } = render(<HaMediaPlayerHost value={withPicture('/api/pic?token=x')} />);
		expect(haMediaArt).toHaveBeenCalledWith('/api/pic?token=x');
		await waitFor(() => {
			const img = container.querySelector('img[data-part="art"]') as HTMLImageElement | null;
			expect(img?.getAttribute('src')).toBe('art://abc');
		});
	});

	it('renders the meter with no art when the entity carries no entity_picture', async () => {
		const { container } = render(<HaMediaPlayerHost value={withPicture()} />);
		// No picture → no fetch, no <img>.
		expect(haMediaArt).not.toHaveBeenCalled();
		expect(container.querySelector('img[data-part="art"]')).toBeNull();
		// The pure meter still renders (root present).
		expect(container.querySelector('[data-part="root"]')).toBeTruthy();
	});

	it('clears the art when the picture is removed on a later render', async () => {
		haMediaArt.mockResolvedValue('art://abc');
		const { container, rerender } = render(
			<HaMediaPlayerHost value={withPicture('/api/pic?token=x')} />
		);
		await waitFor(() => expect(container.querySelector('img[data-part="art"]')).toBeTruthy());
		// Re-render with the picture gone: the effect's !pic branch resets art to undefined.
		rerender(<HaMediaPlayerHost value={withPicture()} />);
		await waitFor(() => expect(container.querySelector('img[data-part="art"]')).toBeNull());
	});

	it('falls back to no art when the fetch rejects', async () => {
		haMediaArt.mockRejectedValue(new Error('boom'));
		const { container } = render(<HaMediaPlayerHost value={withPicture('/api/pic?token=x')} />);
		await waitFor(() => expect(haMediaArt).toHaveBeenCalled());
		// The .catch arm sets art to undefined → no <img>.
		await waitFor(() => expect(container.querySelector('img[data-part="art"]')).toBeNull());
	});

	it('does not apply a resolved URL after unmount (cancelled guard)', async () => {
		let resolveArt!: (url: string) => void;
		haMediaArt.mockReturnValue(new Promise<string>((res) => (resolveArt = res)));
		const { unmount } = render(<HaMediaPlayerHost value={withPicture('/api/pic?token=x')} />);
		expect(haMediaArt).toHaveBeenCalled();
		unmount();
		// Resolving after unmount must not throw or setState on the dead tree (cancelled === true).
		await act(async () => {
			resolveArt('art://late');
		});
	});

	it('ignores a rejection that arrives after unmount (cancelled guard, catch arm)', async () => {
		let rejectArt!: (err: unknown) => void;
		haMediaArt.mockReturnValue(new Promise<string>((_res, rej) => (rejectArt = rej)));
		const { unmount } = render(<HaMediaPlayerHost value={withPicture('/api/pic?token=x')} />);
		expect(haMediaArt).toHaveBeenCalled();
		unmount();
		await act(async () => {
			rejectArt(new Error('late'));
		});
	});
});
