import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createEvent, fireEvent, render, waitFor } from '@testing-library/react';
import NowPlaying from './NowPlaying';
import type { AutoRepeat, PlaybackStatus, SessionRecord } from '../../../stores/stores';

// happy-dom's TransitionEvent constructor drops `propertyName`, so fireEvent.transitionEnd(el, {…})
// can't carry it — the meter filters on e.propertyName === 'opacity'. Build the event and pin the
// property explicitly so the real handler runs (or short-circuits) as it would in a browser.
function fireTransitionEnd(el: Element, propertyName: string) {
	const ev = createEvent.transitionEnd(el);
	Object.defineProperty(ev, 'propertyName', { value: propertyName });
	fireEvent(el, ev);
}

// The transport buttons read playback/timeline from last_model_update.Model (the live model), with
// the media model only as a fallback. Set the model directly so play state / repeat / shuffle / seek
// reflect what we intend (the bare session() fixture leaves Model.playback null).
function withModel(
	s: SessionRecord,
	model: { status?: PlaybackStatus; shuffle?: boolean; auto_repeat?: AutoRepeat },
	timeline?: { start: number; end: number; position: number }
): SessionRecord {
	s.last_model_update = {
		Model: {
			playback: {
				auto_repeat: model.auto_repeat ?? 'None',
				rate: 1,
				shuffle: model.shuffle ?? false,
				status: model.status ?? 'Playing',
				type: 'Music'
			},
			timeline: timeline ? { ...timeline, last_updated_at_ms: 0 } : null,
			media: null,
			source: s.source
		}
	};
	return s;
}

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

// A live session with NO current track: present (so hasSession is true) but its media update is gone,
// so there's no title and no album art. Models a player that tears down / recreates its SMTC session on
// pause — the prior track can't be carried forward (mergeMediaForward has nothing for the new id), so
// the meter sees a session with nothing to show. The cover must leave WITH the (now-empty) title.
const tracklessSession = (): SessionRecord => ({
	session_id: 2,
	source: 'spotify.exe',
	timestamp_created: null,
	timestamp_updated: null,
	last_media_update: null,
	last_model_update: {
		Model: {
			playback: { auto_repeat: 'None', rate: 1, shuffle: false, status: 'Paused', type: 'Music' },
			timeline: null,
			media: null,
			source: 'spotify.exe'
		}
	}
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

describe('NowPlaying — transport controls', () => {
	it('bubbles previous / stop / next with just the source (no value)', () => {
		const onControl = vi.fn();
		const { container } = render(
			<NowPlaying session={session('Song A', ART)} onControl={onControl} />
		);
		for (const [part, service] of [
			['prev', 'previous'],
			['stop', 'stop'],
			['next', 'next']
		] as const) {
			onControl.mockClear();
			fireEvent.click(container.querySelector(`[data-part="${part}"]`) as HTMLElement);
			expect(onControl).toHaveBeenCalledWith({
				domain: 'media',
				service,
				data: { source: 'spotify.exe' }
			});
		}
	});

	it('shuffle press sends the toggled value (off → 1) and is not active when off', () => {
		const onControl = vi.fn();
		const { container } = render(
			<NowPlaying session={session('Song A', ART)} onControl={onControl} />
		);
		const btn = container.querySelector('[data-part="shuffle"]') as HTMLElement;
		expect(btn.getAttribute('data-active')).toBe('false');
		expect(btn.getAttribute('aria-pressed')).toBe('false');
		fireEvent.click(btn);
		expect(onControl).toHaveBeenCalledWith({
			domain: 'media',
			service: 'shuffle',
			data: { source: 'spotify.exe', value: 1 }
		});
	});

	it('shuffle press sends 0 when already on (reflected via data-active / aria-pressed)', () => {
		const onControl = vi.fn();
		const s = withModel(session('Song A', ART), { shuffle: true });
		const { container } = render(<NowPlaying session={s} onControl={onControl} />);
		const btn = container.querySelector('[data-part="shuffle"]') as HTMLElement;
		expect(btn.getAttribute('data-active')).toBe('true');
		expect(btn.getAttribute('aria-pressed')).toBe('true');
		fireEvent.click(btn);
		expect(onControl).toHaveBeenCalledWith({
			domain: 'media',
			service: 'shuffle',
			data: { source: 'spotify.exe', value: 0 }
		});
	});

	it('repeat cycles None → Track (sends value 1) and shows the loop glyph + mode', () => {
		const onControl = vi.fn();
		const { container } = render(
			<NowPlaying session={session('Song A', ART)} onControl={onControl} />
		);
		const btn = container.querySelector('[data-part="repeat"]') as HTMLElement;
		expect(btn.getAttribute('data-mode')).toBe('None');
		expect(btn.getAttribute('aria-label')).toBe('Repeat: None');
		expect(btn.textContent).toBe('🔁');
		fireEvent.click(btn);
		expect(onControl).toHaveBeenCalledWith({
			domain: 'media',
			service: 'repeat',
			data: { source: 'spotify.exe', value: 1 }
		});
	});

	it('repeat in Track mode shows the single-track glyph and cycles to List (value 2)', () => {
		const onControl = vi.fn();
		const s = withModel(session('Song A', ART), { auto_repeat: 'Track' });
		const { container } = render(<NowPlaying session={s} onControl={onControl} />);
		const btn = container.querySelector('[data-part="repeat"]') as HTMLElement;
		expect(btn.getAttribute('data-mode')).toBe('Track');
		expect(btn.textContent).toBe('🔂');
		fireEvent.click(btn);
		expect(onControl).toHaveBeenCalledWith({
			domain: 'media',
			service: 'repeat',
			data: { source: 'spotify.exe', value: 2 }
		});
	});

	it('repeat in List mode cycles back to None (value 0)', () => {
		const onControl = vi.fn();
		const s = withModel(session('Song A', ART), { auto_repeat: 'List' });
		const { container } = render(<NowPlaying session={s} onControl={onControl} />);
		const btn = container.querySelector('[data-part="repeat"]') as HTMLElement;
		fireEvent.click(btn);
		expect(onControl).toHaveBeenCalledWith({
			domain: 'media',
			service: 'repeat',
			data: { source: 'spotify.exe', value: 0 }
		});
	});

	it('play/pause shows the pause glyph while playing and the play glyph while paused', () => {
		const playingS = withModel(session('Song A', ART), { status: 'Playing' });
		const { container, rerender } = render(<NowPlaying session={playingS} />);
		expect(container.querySelector('[data-part="playpause"]')!.textContent).toBe('⏸');
		expect(container.querySelector('[data-part="root"]')!.getAttribute('data-playing')).toBe(
			'true'
		);
		const paused = withModel(session('Song A', ART), { status: 'Paused' });
		rerender(<NowPlaying session={paused} />);
		expect(container.querySelector('[data-part="playpause"]')!.textContent).toBe('▶');
		expect(container.querySelector('[data-part="root"]')!.getAttribute('data-playing')).toBe(
			'false'
		);
	});

	it('omits source from the payload when the session has no source', () => {
		const onControl = vi.fn();
		const s = session('Song A', ART);
		s.source = '';
		s.last_media_update!.Media[0].source = '';
		const { container } = render(<NowPlaying session={s} onControl={onControl} />);
		fireEvent.click(container.querySelector('[data-part="next"]') as HTMLElement);
		expect(onControl).toHaveBeenCalledWith({ domain: 'media', service: 'next', data: {} });
	});

	it('a transport press stops propagation (does not reach the widget behind it)', () => {
		const onControl = vi.fn();
		const behind = vi.fn();
		const { container } = render(
			<div onClick={behind}>
				<NowPlaying session={session('Song A', ART)} onControl={onControl} />
			</div>
		);
		fireEvent.click(container.querySelector('[data-part="next"]') as HTMLElement);
		expect(onControl).toHaveBeenCalledTimes(1);
		expect(behind).not.toHaveBeenCalled();
	});

	it('does nothing on a transport press when no onControl is wired (optional chaining)', () => {
		const { container } = render(<NowPlaying session={session('Song A', ART)} />);
		// No onControl prop: the click must not throw.
		expect(() =>
			fireEvent.click(container.querySelector('[data-part="next"]') as HTMLElement)
		).not.toThrow();
	});
});

// The progress bar is hidden by default but is a live, click-to-seek control when the session
// reports `seek` support. The position/duration timers render the formatted time from the timeline.
describe('NowPlaying — seek + timeline', () => {
	const seekableSession = (): SessionRecord => {
		const s = session('Song A', ART);
		// liveModel falls back to the media model; give it a real timeline for position/duration.
		s.last_model_update = {
			Model: {
				playback: {
					auto_repeat: 'None',
					rate: 1,
					shuffle: false,
					status: 'Playing',
					type: 'Music'
				},
				timeline: { start: 0, end: 200, position: 65, last_updated_at_ms: 0 },
				media: null,
				source: 'spotify.exe'
			}
		};
		return s;
	};
	const caps = {
		play: true,
		pause: true,
		playpause: true,
		stop: true,
		next: true,
		previous: true,
		shuffle: true,
		repeat: true,
		seek: true
	};

	it('renders position / duration timers and the fill width from the timeline', () => {
		const { container } = render(<NowPlaying session={seekableSession()} />);
		expect(container.querySelector('[data-part="position"]')!.textContent).toBe('1:05');
		expect(container.querySelector('[data-part="duration"]')!.textContent).toBe('3:20');
		// 65 / 200 = 32.5%
		expect(
			(container.querySelector('[data-part="progress-fill"]') as HTMLElement).style.width
		).toBe('32.5%');
	});

	it('clicking the seekable progress bar sends seek to the clicked fraction of the duration', () => {
		const onControl = vi.fn();
		const { container } = render(
			<NowPlaying session={seekableSession()} caps={caps} onControl={onControl} />
		);
		const bar = container.querySelector('[data-part="progress"]') as HTMLElement;
		expect(bar.getAttribute('data-seekable')).toBe('true');
		// happy-dom getBoundingClientRect returns zeros; stub a 200px-wide bar so the fraction is real.
		bar.getBoundingClientRect = () =>
			({ left: 0, width: 200, top: 0, height: 4, right: 200, bottom: 4, x: 0, y: 0 } as DOMRect);
		fireEvent.click(bar, { clientX: 100 }); // halfway → 0.5 * 200 = 100
		expect(onControl).toHaveBeenCalledWith({
			domain: 'media',
			service: 'seek',
			data: { source: 'spotify.exe', value: 100 }
		});
	});

	it('clamps a seek click past the right edge to the end of the track', () => {
		const onControl = vi.fn();
		const { container } = render(
			<NowPlaying session={seekableSession()} caps={caps} onControl={onControl} />
		);
		const bar = container.querySelector('[data-part="progress"]') as HTMLElement;
		bar.getBoundingClientRect = () =>
			({ left: 0, width: 200, top: 0, height: 4, right: 200, bottom: 4, x: 0, y: 0 } as DOMRect);
		fireEvent.click(bar, { clientX: 9999 }); // past the end → clamped to frac 1 → full duration
		expect(onControl).toHaveBeenCalledWith({
			domain: 'media',
			service: 'seek',
			data: { source: 'spotify.exe', value: 200 }
		});
	});

	it('a seek click with a zero-duration timeline is a no-op', () => {
		const onControl = vi.fn();
		const s = seekableSession();
		s.last_model_update!.Model.timeline!.end = 0;
		const { container } = render(<NowPlaying session={s} caps={caps} onControl={onControl} />);
		const bar = container.querySelector('[data-part="progress"]') as HTMLElement;
		fireEvent.click(bar, { clientX: 50 });
		expect(onControl).not.toHaveBeenCalled();
	});

	it('the progress bar is not clickable when the session does not support seeking', () => {
		const onControl = vi.fn();
		const noSeek = { ...caps, seek: false };
		const { container } = render(
			<NowPlaying session={seekableSession()} caps={noSeek} onControl={onControl} />
		);
		const bar = container.querySelector('[data-part="progress"]') as HTMLElement;
		expect(bar.getAttribute('data-seekable')).toBe('false');
		fireEvent.click(bar, { clientX: 50 });
		expect(onControl).not.toHaveBeenCalled();
	});
});

// The crossfade stack adds/removes <img> layers on art changes; transitionend drives the cleanup.
describe('NowPlaying — crossfade layer lifecycle (transitionend)', () => {
	it('removes a faded-out layer when its opacity transition ends', async () => {
		const { container, rerender } = await renderWithLoadedCover();
		// New, distinct art → the old (visible) layer becomes outgoing (loaded:false), a new one is pushed.
		const next = session('Song B', 'http://art.localhost/456');
		rerender(<NowPlaying session={next} />);
		await waitFor(() => {
			expect(container.querySelectorAll('.np-thumb').length).toBe(2);
		});
		const outgoing = container.querySelector('.np-thumb[src="http://art.localhost/123"]')!;
		fireTransitionEnd(outgoing, 'opacity');
		await waitFor(() => {
			expect(container.querySelector('.np-thumb[src="http://art.localhost/123"]')).toBeNull();
		});
	});

	it('a faded-in layer drops everything beneath it on transitionend', async () => {
		const { container, rerender } = await renderWithLoadedCover();
		const next = session('Song B', 'http://art.localhost/456');
		rerender(<NowPlaying session={next} />);
		const incoming = await waitFor(() => {
			const el = container.querySelector('.np-thumb[src="http://art.localhost/456"]');
			if (!el) throw new Error('no incoming layer');
			return el as HTMLImageElement;
		});
		fireEvent.load(incoming); // decode → rAF → loaded:true
		await waitFor(() => expect(incoming.getAttribute('data-loaded')).toBe('true'));
		// The newly-shown (loaded) layer finishing its fade drops all older layers beneath it.
		fireTransitionEnd(incoming, 'opacity');
		await waitFor(() => {
			const imgs = container.querySelectorAll('.np-thumb');
			expect(imgs.length).toBe(1);
			expect(imgs[0].getAttribute('src')).toBe('http://art.localhost/456');
		});
	});

	it('ignores a transitionend for a property other than opacity', async () => {
		const { container, img } = await renderWithLoadedCover();
		fireTransitionEnd(img, 'transform');
		// The layer survives an unrelated transition end.
		expect(container.querySelectorAll('.np-thumb').length).toBe(1);
	});

	it('flips a layer in even when the image element has no decode() (older webview)', async () => {
		const proto = window.HTMLImageElement.prototype as { decode?: unknown };
		const orig = Object.getOwnPropertyDescriptor(proto, 'decode');
		// Simulate an <img> without decode() so onLayerLoad takes the synchronous flip path.
		Object.defineProperty(proto, 'decode', { value: undefined, configurable: true });
		try {
			const view = render(<NowPlaying session={session('Song A', ART)} />);
			const img = await waitFor(() => {
				const el = view.container.querySelector('.np-thumb') as HTMLImageElement | null;
				if (!el) throw new Error('no cover layer yet');
				return el;
			});
			fireEvent.load(img);
			await waitFor(() => expect(img.getAttribute('data-loaded')).toBe('true'));
		} finally {
			if (orig) Object.defineProperty(proto, 'decode', orig);
		}
	});

	it('still flips a layer in when decode() rejects (src superseded)', async () => {
		const proto = window.HTMLImageElement.prototype as { decode?: unknown };
		const orig = Object.getOwnPropertyDescriptor(proto, 'decode');
		Object.defineProperty(proto, 'decode', {
			value: () => Promise.reject(new Error('superseded')),
			configurable: true
		});
		try {
			const view = render(<NowPlaying session={session('Song A', ART)} />);
			const img = await waitFor(() => {
				const el = view.container.querySelector('.np-thumb') as HTMLImageElement | null;
				if (!el) throw new Error('no cover layer yet');
				return el;
			});
			fireEvent.load(img);
			await waitFor(() => expect(img.getAttribute('data-loaded')).toBe('true'));
		} finally {
			if (orig) Object.defineProperty(proto, 'decode', orig);
		}
	});
});

// Art-clearing paths: the player vanishing drops every layer immediately; an art-less track keeps the
// stale cover for a grace window then fades it out, unless new art arrives first.
describe('NowPlaying — art clearing', () => {
	it('drops every cover layer immediately when the player goes away', async () => {
		const { container, rerender } = await renderWithLoadedCover();
		expect(container.querySelectorAll('.np-thumb').length).toBe(1);
		rerender(<NowPlaying session={null} />);
		await waitFor(() => expect(container.querySelectorAll('.np-thumb').length).toBe(0));
		// With no title and no layers the whole body collapses (only the root remains).
		expect(container.querySelector('[data-part="title"]')).toBeNull();
	});

	it('drops the cover at once when the session loses its track — not held (expanding) on the no-art grace', async () => {
		const { container, rerender } = await renderWithLoadedCover();
		expect(container.querySelectorAll('.np-thumb').length).toBe(1);
		// The active session now carries no track (no media → no title, no art). The title disappears at
		// once (it's read straight from props), so the cover must too — otherwise it lingers on the no-art
		// grace, expanding to fill the box where the title/artist were before finally fading (the reported
		// "cover expands for a short while then disappears" on pause). This differs from a genuine art-lag
		// (a track IS present, its cover just hasn't arrived) below, where keeping the cover is correct.
		rerender(<NowPlaying session={tracklessSession()} />);
		expect(container.querySelectorAll('.np-thumb').length).toBe(0);
		// The artist row is gone with the track — the cover did not outlive it.
		expect(container.querySelector('[data-part="artist"]')).toBeNull();
	});

	it('keeps the stale cover during the grace window, then fades it out for a genuinely art-less track', async () => {
		const { container, rerender } = await renderWithLoadedCover();
		vi.useFakeTimers();
		// Same track stays playing but its art is now gone (null thumb): hold the previous cover up.
		rerender(<NowPlaying session={session('Song A', null)} />);
		expect(container.querySelectorAll('.np-thumb').length).toBe(1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1300); // past NO_ART_GRACE_MS (1200)
		});
		// The visible layer is now fading out (loaded:false) ahead of its self-removal on transitionend.
		expect(container.querySelector('.np-thumb')!.getAttribute('data-loaded')).toBe('false');
	});

	it('cancels the pending no-art teardown when fresh art arrives before the grace elapses', async () => {
		const { container, rerender } = await renderWithLoadedCover();
		vi.useFakeTimers();
		rerender(<NowPlaying session={session('Song A', null)} />); // schedules the teardown timer
		await act(async () => {
			await vi.advanceTimersByTimeAsync(300); // still within the grace window
		});
		// New art arrives in time → supersedes the pending teardown (the timer is cleared).
		rerender(<NowPlaying session={session('Song A', 'http://art.localhost/789')} />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000); // well past the original grace deadline
		});
		// The old cover was not torn down by the cancelled timer; the new art layer is present.
		expect(container.querySelector('.np-thumb[src="http://art.localhost/789"]')).not.toBeNull();
	});

	it('clears a pending no-art teardown timer on unmount (no late state update)', async () => {
		const { rerender, unmount } = await renderWithLoadedCover();
		vi.useFakeTimers();
		rerender(<NowPlaying session={session('Song A', null)} />); // schedules the teardown timer
		// A fired-after-unmount setState logs a React "setState on unmounted component" act warning via
		// console.error. test-setup.ts doesn't fail on that, so assert it explicitly: the cleanup must
		// cancel the timer so it never fires against the dead instance.
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		unmount(); // cleanup cancels the pending teardown timer
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000); // would have fired the teardown if not cleared
		});
		expect(errorSpy).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});

// The song-change grey cue has several conditional arms around which layers exist and are loaded.
describe('NowPlaying — grey cue edge cases', () => {
	it('does not grey anything when the track changes before any cover has loaded', async () => {
		// Render art but never fire load → a single not-yet-loaded layer exists.
		const view = render(<NowPlaying session={session('Song A', ART)} />);
		const img = await waitFor(() => {
			const el = view.container.querySelector('.np-thumb') as HTMLImageElement | null;
			if (!el) throw new Error('no cover layer yet');
			return el;
		});
		expect(img.getAttribute('data-loaded')).toBe('false');
		// Track change with no loaded layer → grey effect's `.some(loaded)` is false → layers unchanged.
		view.rerender(<NowPlaying session={session('Song B', ART)} />);
		const after = view.container.querySelector('.np-thumb') as HTMLImageElement;
		expect(after.getAttribute('data-leaving')).toBe('false');
	});

	it('greys only the loaded layer, leaving an in-flight incoming layer in colour', async () => {
		const { container, rerender } = await renderWithLoadedCover();
		// New art (distinct url) pushes an incoming layer that has NOT loaded yet, over the loaded one.
		rerender(<NowPlaying session={session('Song B', 'http://art.localhost/456')} />);
		await waitFor(() => expect(container.querySelectorAll('.np-thumb').length).toBe(2));
		// Now change the track again (same art urls) so the grey effect runs over a mixed loaded set.
		rerender(<NowPlaying session={session('Song C', 'http://art.localhost/456')} />);
		const loaded = container.querySelector('.np-thumb[src="http://art.localhost/123"]')!;
		const notLoaded = container.querySelector('.np-thumb[src="http://art.localhost/456"]')!;
		expect(loaded.getAttribute('data-loaded')).toBe('false'); // outgoing copy, fading out
		// The grey effect maps loaded → leaving and leaves the not-yet-loaded incoming layer untouched.
		expect(notLoaded.getAttribute('data-leaving')).toBe('false');
	});

	it('on a track change, greys the loaded layer but leaves a stale not-loaded layer as-is', async () => {
		const { container, rerender } = await renderWithLoadedCover(); // {123, loaded}
		// Art change (same track) → outgoing {123, loaded:false} + incoming {456, loaded:false}.
		rerender(<NowPlaying session={session('Song A', 'http://art.localhost/456')} />);
		const incoming = await waitFor(() => {
			const el = container.querySelector('.np-thumb[src="http://art.localhost/456"]');
			if (!el) throw new Error('no incoming layer');
			return el as HTMLImageElement;
		});
		fireEvent.load(incoming); // 456 → loaded:true; 123 stays loaded:false (its transitionend unfired)
		await waitFor(() => expect(incoming.getAttribute('data-loaded')).toBe('true'));
		// Now change the TRACK: grey effect runs over [123 not-loaded, 456 loaded] → 456 greys, 123 as-is.
		rerender(<NowPlaying session={session('Song B', 'http://art.localhost/456')} />);
		const stale = container.querySelector('.np-thumb[src="http://art.localhost/123"]')!;
		await waitFor(() => expect(incoming.getAttribute('data-leaving')).toBe('true'));
		expect(stale.getAttribute('data-loaded')).toBe('false');
		expect(stale.getAttribute('data-leaving')).toBe('false'); // the not-loaded layer is left untouched
	});

	it('the grey-recovery timer leaves a not-yet-loaded layer untouched (only loaded layers recover)', async () => {
		const { container, rerender } = await renderWithLoadedCover();
		vi.useFakeTimers();
		// Push an incoming (not-yet-loaded) layer alongside the loaded outgoing one.
		rerender(<NowPlaying session={session('Song B', 'http://art.localhost/456')} />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0); // flush the crossfade effect so both layers commit
		});
		expect(container.querySelectorAll('.np-thumb').length).toBe(2);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000); // fire the grey-recovery timer (GREY_HOLD_MS = 900)
		});
		// The not-yet-loaded incoming layer is untouched by the recovery map (it only flips loaded ones).
		const notLoaded = container.querySelector('.np-thumb[src="http://art.localhost/456"]');
		expect(notLoaded).not.toBeNull();
		expect(notLoaded!.getAttribute('data-leaving')).toBe('false');
	});

	it('clears a previously-pending grey timer when the track changes a second time', async () => {
		const { img, rerender } = await renderWithLoadedCover();
		vi.useFakeTimers();
		rerender(<NowPlaying session={session('Song B', ART)} />); // schedules the first grey timer
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100); // still within GREY_HOLD_MS
		});
		expect(img.getAttribute('data-leaving')).toBe('true');
		// Second track change while the first grey timer is pending → it must be cleared and re-armed.
		rerender(<NowPlaying session={session('Song C', ART)} />);
		expect(img.getAttribute('data-leaving')).toBe('true');
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000); // past the (re-armed) hold → recover to colour
		});
		expect(img.getAttribute('data-leaving')).toBe('false');
	});

	it('clears a pending grey-recovery timer on unmount', async () => {
		const { rerender, unmount } = await renderWithLoadedCover();
		vi.useFakeTimers();
		rerender(<NowPlaying session={session('Song B', ART)} />); // schedules the grey timer
		// If the recovery timer fired after unmount it would setState on a dead instance, which React
		// reports via a console.error act warning (test-setup.ts doesn't fail on it). Assert it never
		// fires by checking console.error stays silent past the (would-be) recovery deadline.
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		unmount(); // cleanup cancels the pending grey timer
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000); // would have fired had it not been cleared
		});
		expect(errorSpy).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});
