import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

// Stub the Tauri-backed media adapter (no backend in tests): the host must still boot the feed and
// fetch capabilities through it. Caps hide everything but play/pause so the wiring is observable.
const { startMediaSource, getMediaCapabilities } = vi.hoisted(() => ({
	startMediaSource: vi.fn(),
	getMediaCapabilities: vi.fn(() =>
		Promise.resolve({
			play: true,
			pause: true,
			playpause: true,
			stop: false,
			next: false,
			previous: false,
			shuffle: false,
			repeat: false,
			seek: false
		})
	)
}));
vi.mock('../components/NowPlaying/source', () => ({ startMediaSource, getMediaCapabilities }));

import NowPlayingHost from './NowPlayingHost';
import { defaultState, mediaStore, type SessionRecord } from '../../stores/stores';

const session = (title: string): SessionRecord => ({
	session_id: 1,
	source: 'spotify.exe',
	timestamp_created: null,
	timestamp_updated: null,
	last_media_update: {
		Media: [
			{
				source: 'spotify.exe',
				playback: {
					auto_repeat: 'None',
					rate: 1,
					shuffle: false,
					status: 'Playing',
					type: 'Music'
				},
				timeline: { start: 0, end: 100, position: 25, last_updated_at_ms: 0 },
				media: {
					album: null,
					artist: 'A',
					genres: [],
					playback_type: 'Music',
					subtitle: '',
					title,
					track_number: null
				}
			},
			null
		]
	},
	last_model_update: { Model: { playback: null, timeline: null, media: null, source: '' } }
});

beforeEach(() => {
	startMediaSource.mockClear();
	getMediaCapabilities.mockClear();
	mediaStore.set({ ...defaultState, sourcePriority: '', sessions: { 1: session('Song A') } });
});

describe('NowPlayingHost (container wiring)', () => {
	it('boots the media feed and renders the active session from mediaStore as meter props', async () => {
		const { container } = render(<NowPlayingHost />);
		expect(startMediaSource).toHaveBeenCalledOnce();
		await waitFor(() =>
			expect(container.querySelector('[data-part="title"]')?.textContent).toBe('Song A')
		);
	});

	it('fetches the session capabilities and passes them down (unsupported buttons hidden)', async () => {
		const { container } = render(<NowPlayingHost />);
		expect(getMediaCapabilities).toHaveBeenCalledWith('spotify.exe');
		await waitFor(() => {
			expect(container.querySelector('[data-part="playpause"]')).not.toBeNull();
			expect(container.querySelector('[data-part="next"]')).toBeNull(); // caps.next === false
		});
	});

	it('renders the empty meter and queries default caps when no session is active', async () => {
		mediaStore.set({ ...defaultState, sourcePriority: '', sessions: {} });
		const { container } = render(<NowPlayingHost />);
		expect(getMediaCapabilities).toHaveBeenCalledWith(undefined); // no session → no source
		// the meter renders its bare, not-playing root — no track parts at all
		await waitFor(() => {
			expect(container.querySelector('[data-part="root"]')?.getAttribute('data-playing')).toBe(
				'false'
			);
			expect(container.querySelector('[data-part="title"]')).toBeNull();
		});
	});

	it('ignores a capabilities result that resolves only after unmount (alive guard)', async () => {
		const caps = {
			play: true,
			pause: true,
			playpause: true,
			stop: false,
			next: false,
			previous: false,
			shuffle: false,
			repeat: false,
			seek: false
		};
		let resolveCaps!: (c: typeof caps) => void;
		getMediaCapabilities.mockReturnValueOnce(
			new Promise<typeof caps>((r) => {
				resolveCaps = r;
			})
		);
		const { unmount } = render(<NowPlayingHost />);
		unmount();
		// The late resolution must be dropped (alive === false) — no setState on the unmounted host.
		await act(async () => {
			resolveCaps(caps);
		});
		expect(getMediaCapabilities).toHaveBeenCalledTimes(1);
	});
});
