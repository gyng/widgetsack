import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import NowPlaying from './NowPlaying';
import type { SessionRecord } from '../../../stores/stores';

// The cover is now a backend-served URL (art.rs), so the meter just sets it as the <img src> — no
// object URLs to stub. artKey is the url itself, so a distinct url = a distinct cover (crossfade).
const ART = 'http://art.localhost/123'; // a stable cover url for the active track

const session = (title: string, art: string | null): SessionRecord => ({
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
			art ? { content_type: 'image/png', url: art } : null
		]
	},
	last_model_update: { Model: { playback: null, timeline: null, media: null, source: '' } }
});

// Render NowPlaying (props-driven — the NowPlayingHost container does the store wiring in the app)
// showing a track whose cover has loaded (the visible, full-colour layer).
async function renderWithLoadedCover() {
	const view = render(<NowPlaying session={session('Song A', ART)} />);
	const img = await waitFor(() => {
		const el = view.container.querySelector('.np-thumb') as HTMLImageElement | null;
		if (!el) throw new Error('no cover layer yet');
		return el;
	});
	fireEvent.load(img); // onLayerLoad → rAF → loaded:true (opacity fades in)
	await waitFor(() => expect(img.getAttribute('data-loaded')).toBe('true'));
	return { ...view, img };
}

afterEach(() => vi.useRealTimers());

describe('NowPlaying — song-change grey cue', () => {
	it('the freshly-loaded cover is in full colour (not leaving)', async () => {
		const { img } = await renderWithLoadedCover();
		expect(img.getAttribute('data-leaving')).toBe('false');
	});

	it('greys the previous cover (data-leaving) the instant the song changes — even with no new art', async () => {
		const { img, rerender } = await renderWithLoadedCover();
		// Same cover bytes (same album → no crossfade), only the title changes: still must grey at once.
		rerender(<NowPlaying session={session('Song B', ART)} />);
		await waitFor(() => expect(img.getAttribute('data-leaving')).toBe('true'));
	});

	it('recovers the same cover to colour after the hold (same-album reuse never sticks grey)', async () => {
		const { img, rerender } = await renderWithLoadedCover();
		vi.useFakeTimers();
		rerender(<NowPlaying session={session('Song B', ART)} />);
		expect(img.getAttribute('data-leaving')).toBe('true');
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000); // past GREY_HOLD_MS
		});
		expect(img.getAttribute('data-leaving')).toBe('false');
	});
});

describe('NowPlaying — capabilities', () => {
	it('shows every transport control when caps are unknown (null)', async () => {
		const { container } = await renderWithLoadedCover();
		for (const part of ['shuffle', 'prev', 'playpause', 'stop', 'next', 'repeat']) {
			expect(container.querySelector(`[data-part="${part}"]`)).not.toBeNull();
		}
	});

	it('hides the controls the session does not support', () => {
		const caps = {
			play: true,
			pause: true,
			playpause: true,
			stop: false,
			next: true,
			previous: false,
			shuffle: false,
			repeat: false,
			seek: false
		};
		const { container } = render(<NowPlaying session={session('Song A', ART)} caps={caps} />);
		expect(container.querySelector('[data-part="playpause"]')).not.toBeNull();
		expect(container.querySelector('[data-part="next"]')).not.toBeNull();
		expect(container.querySelector('[data-part="prev"]')).toBeNull();
		expect(container.querySelector('[data-part="stop"]')).toBeNull();
		expect(container.querySelector('[data-part="shuffle"]')).toBeNull();
		expect(container.querySelector('[data-part="repeat"]')).toBeNull();
	});

	it('bubbles a transport press up via onControl with the session source', () => {
		const onControl = vi.fn();
		const { container } = render(
			<NowPlaying session={session('Song A', ART)} onControl={onControl} />
		);
		fireEvent.click(container.querySelector('[data-part="playpause"]') as HTMLElement);
		expect(onControl).toHaveBeenCalledWith({
			domain: 'media',
			service: 'playpause',
			data: { source: 'spotify.exe' }
		});
	});
});
