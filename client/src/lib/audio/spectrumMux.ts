// Per-config spectrum stream multiplexer — the ref-counting / debounce / watchdog logic behind
// `source.ts`, with the Tauri IO injected so it is unit-testable. Each distinct (device, scale) a
// mounted Spectrum meter asks for is its own STREAM (own key, own backend Channel, own subscriber
// count): meters with the same config share one, meters with different configs never override each
// other (the backend runs one capture per device and bins per stream scale).

/** One analysed frame. Mirrors `SpectrumFrame` in `widgetsack/src/audio.rs`. */
export type SpectrumFrame = { bands: number[]; rms: number; ts_ms: number };

export type SpectrumScale = 'log' | 'linear';

/** What one meter holds while mounted: frames for ITS config, plus a release. */
export interface SpectrumSubscription {
	/** Subscribe to every frame of this stream as it arrives. Returns an unsubscribe fn. */
	onFrame(cb: (frame: SpectrumFrame) => void): () => void;
	/** The stream's most recent frame, or null before the first / after teardown. */
	latestFrame(): SpectrumFrame | null;
	/** Drop this subscription (idempotent); the stream stops (debounced) after its last one. */
	release(): void;
}

/** The IO the mux drives: start / stop one backend stream, keyed. */
export type SpectrumMuxDeps = {
	start(key: string, device: string, scale: SpectrumScale): Promise<unknown>;
	stop(key: string): void;
	now(): number;
	warn(message: string, detail?: unknown): void;
};

/** Normalise a widget's scale config ('linear' or anything else → 'log'). */
export function normalizeScale(scale: string | undefined): SpectrumScale {
	return scale === 'linear' ? 'linear' : 'log';
}

/** The stream key for a config. Device ids are opaque WASAPI endpoint ids; the scale is a fixed
 * word without '|', so the key is unambiguous. */
export function spectrumKey(device: string, scale: SpectrumScale): string {
	return `${scale}|${device}`;
}

// A widget dragged across the layout (floating → into a cell) unmounts then remounts within a frame
// or two — and a flow-container leaf briefly renders a fallback host before its measured one. Each
// flip releases then re-acquires; tearing capture down and back up that fast both thrashes the Channel
// and races the start/stop invokes on the backend (a late-landing `stop_spectrum` can wedge it stopped
// even though a live subscriber re-acquired). Debounce the stop so a transient drop to zero subscribers
// keeps the existing stream alive instead.
export const STOP_DEBOUNCE_MS = 400;
// A healthy stream pushes a frame at least every ~250 ms (the backend's silent-throttle interval),
// so a longer gap while a meter is mounted means capture stalled — the thread gave up after repeated
// device errors, or the channel desynced. Push rendering has no other recovery (it just freezes on
// the last frame), so a slow timer restarts the stalled stream to self-heal.
export const STALL_MS = 2500;

type Stream = {
	key: string;
	device: string;
	scale: SpectrumScale;
	refs: number;
	/** Whether the backend stream is (believed to be) running. Reset if the start invoke fails, so the
	 * watchdog / a later acquire retries instead of being wedged "started" with no real stream. */
	started: boolean;
	stopTimer: ReturnType<typeof setTimeout> | null;
	latest: SpectrumFrame | null;
	lastFrameAt: number;
	listeners: Set<(frame: SpectrumFrame) => void>;
};

export type SpectrumMux = {
	acquire(device?: string, scale?: string): SpectrumSubscription;
	/** Route a frame from stream `key`'s Channel. Frames for a stopped / unknown stream are dropped. */
	deliver(key: string, frame: SpectrumFrame): void;
	/** Window hidden: stop every running stream (a hidden webview can't show the bars). */
	pause(): void;
	/** Window visible again: restart every stream that still has subscribers. */
	resume(): void;
	/** Whether any backend stream is believed running (the unload path tells the backend to stop). */
	anyStarted(): boolean;
};

export function createSpectrumMux(deps: SpectrumMuxDeps): SpectrumMux {
	const streams = new Map<string, Stream>();
	let hidden = false;
	let watchdog: ReturnType<typeof setInterval> | null = null;

	// The watchdog runs only while some visible stream has subscribers.
	const syncWatchdog = (): void => {
		const needed = !hidden && [...streams.values()].some((s) => s.refs > 0);
		if (needed && watchdog === null) {
			watchdog = setInterval(() => {
				const now = deps.now();
				for (const s of streams.values()) {
					if (s.refs > 0 && now - s.lastFrameAt > STALL_MS) {
						deps.warn(`spectrum: no frames received on ${s.key} — restarting capture`);
						startStream(s);
					}
				}
			}, STALL_MS);
		} else if (!needed && watchdog !== null) {
			clearInterval(watchdog);
			watchdog = null;
		}
	};

	const clearStopTimer = (s: Stream): void => {
		if (s.stopTimer !== null) {
			clearTimeout(s.stopTimer);
			s.stopTimer = null;
		}
	};

	const stopStream = (s: Stream): void => {
		s.latest = null;
		s.started = false;
		clearStopTimer(s);
		deps.stop(s.key);
	};

	/** Stop + forget an idle stream (no subscribers left). */
	const retire = (s: Stream): void => {
		if (s.started) stopStream(s);
		clearStopTimer(s);
		if (streams.get(s.key) === s) streams.delete(s.key);
		syncWatchdog();
	};

	function startStream(s: Stream): void {
		s.started = true;
		// Grace the backend a full STALL_MS to produce the first frame before the watchdog retries.
		s.lastFrameAt = deps.now();
		deps
			.start(s.key, s.device, s.scale)
			.then(() => {
				// Released again before the start landed → undo it so we don't capture with no consumer.
				if (s.refs === 0 && s.started) retire(s);
			})
			.catch((err: unknown) => {
				deps.warn('start_spectrum failed', err);
				s.started = false; // let the watchdog / a later acquire retry
			});
	}

	return {
		acquire(device = '', scale) {
			const sc = normalizeScale(scale);
			const key = spectrumKey(device, sc);
			let s = streams.get(key);
			if (!s) {
				s = {
					key,
					device,
					scale: sc,
					refs: 0,
					started: false,
					stopTimer: null,
					latest: null,
					lastFrameAt: 0,
					listeners: new Set()
				};
				streams.set(key, s);
			}
			const stream = s;
			stream.refs += 1;
			// Cancel a pending stop: this acquire is the remount of a widget that just released, so keep
			// the stream that's still running rather than tearing it down and racing a restart.
			clearStopTimer(stream);
			if (!stream.started && !hidden) startStream(stream);
			syncWatchdog();

			const mine = new Set<(frame: SpectrumFrame) => void>();
			let released = false;
			return {
				onFrame(cb) {
					// Wrap so the same callback registered twice is two subscriptions.
					const wrapped = (frame: SpectrumFrame): void => cb(frame);
					stream.listeners.add(wrapped);
					mine.add(wrapped);
					return () => {
						stream.listeners.delete(wrapped);
						mine.delete(wrapped);
					};
				},
				latestFrame() {
					return stream.latest;
				},
				release() {
					if (released) return;
					released = true;
					for (const cb of mine) stream.listeners.delete(cb);
					mine.clear();
					stream.refs -= 1;
					// Debounced (not immediate): a drag-induced unmount→remount drops to zero for a frame
					// or two, and tearing capture down then up races the backend start/stop.
					if (stream.refs === 0 && stream.stopTimer === null) {
						stream.stopTimer = setTimeout(() => {
							stream.stopTimer = null;
							if (stream.refs === 0) retire(stream);
						}, STOP_DEBOUNCE_MS);
					}
					syncWatchdog();
				}
			};
		},
		deliver(key, frame) {
			const s = streams.get(key);
			if (!s || !s.started) return;
			s.latest = frame;
			s.lastFrameAt = deps.now();
			s.listeners.forEach((cb) => cb(frame));
		},
		pause() {
			hidden = true;
			for (const s of streams.values()) {
				if (s.refs === 0) retire(s); // a pending debounced stop: settle it now
				else if (s.started) stopStream(s);
			}
			syncWatchdog();
		},
		resume() {
			hidden = false;
			for (const s of streams.values()) if (s.refs > 0 && !s.started) startStream(s);
			syncWatchdog();
		},
		anyStarted() {
			return [...streams.values()].some((s) => s.started);
		}
	};
}
