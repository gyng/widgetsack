// Outer-ring adapter (AGENTS.md §5): bridges the Rust `spectrum` Channel stream into a small
// ref-counted singleton that the Spectrum meter consumes via context. The Tauri dependency lives
// here, never in the meter or in core/. One capture stream per window; mounted Spectrum meters
// ref-count it, so capture starts on the first widget and stops when the last unmounts (the demand
// gate, mirroring the sensor active-set). Bridge contract: `SpectrumFrame` / `AudioDevice` mirror
// the Rust structs in widgetsack/src/audio.rs; the command names must match.

import { Channel, invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../bridge/contract';

/** One analysed frame. Mirrors `SpectrumFrame` in `widgetsack/src/audio.rs`. */
export type SpectrumFrame = { bands: number[]; rms: number; ts_ms: number };

/** An audio output device. Mirrors `AudioDevice` in `widgetsack/src/audio.rs`. */
export type AudioDevice = { id: string; name: string };

/** What the Spectrum meter needs: keep the stream alive while mounted, and be PUSHED each frame as
 * it arrives. Push (not a rAF pull-loop) matters because the overlay is an always-on-top, transparent
 * window whose requestAnimationFrame can be throttled by the compositor — driving the draw straight
 * off the Channel message keeps it real-time. (No React state per frame — a 60 Hz setState would
 * thrash rendering; the meter paints a canvas imperatively instead.) */
export interface SpectrumSource {
	/** Keep the capture stream running while subscribed; `device` is the output endpoint id (empty
	 * = system default), `scale` is 'log' | 'linear' band spacing. Returns a release function. */
	acquire(device?: string, scale?: string): () => void;
	/** Subscribe to every frame as it arrives (drives the meter's draw). Returns an unsubscribe fn. */
	onFrame(cb: (frame: SpectrumFrame) => void): () => void;
	/** The most recent frame, or null before the first arrives / after teardown (for the initial paint). */
	latestFrame(): SpectrumFrame | null;
}

/** FFT bands the backend emits. The meter groups these down to its display bar count, so capture
 * resolution is decoupled from how many bars are drawn (and multiple meters can't fight over it). */
const CAPTURE_BANDS = 128;

let latest: SpectrumFrame | null = null;
let channel: Channel<SpectrumFrame> | null = null;
const frameListeners = new Set<(frame: SpectrumFrame) => void>();
let refCount = 0;
/** Whether a capture stream is (believed to be) running on the backend. Reset to false if the start
 * invoke fails, so a later acquire retries instead of being wedged "started" with no real stream. */
let started = false;
let currentDevice = '';
let currentScale = 'log';

// A widget dragged across the layout (floating → into a cell) unmounts then remounts within a frame
// or two — and a flow-container leaf briefly renders a fallback host before its measured one. Each
// flip releases then re-acquires; tearing capture down and back up that fast both thrashes the Channel
// and races the start/stop invokes on the backend (a late-landing `stop_spectrum` can wedge it stopped
// even though a live subscriber re-acquired). Debounce the stop so a transient drop to zero subscribers
// keeps the existing stream alive instead.
const STOP_DEBOUNCE_MS = 400;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

// --- stall watchdog -------------------------------------------------------------------------------
// A healthy stream pushes a frame at least every ~250 ms (the backend's silent-throttle interval),
// so a longer gap while a meter is mounted means capture stalled — the thread gave up after repeated
// device errors, or the channel desynced. Push rendering has no other recovery (it just freezes on
// the last frame), so a slow timer restarts the stream to self-heal. `performance.now()` is monotonic.
const STALL_MS = 2500;
let lastFrameAt = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;

function startWatchdog(): void {
	if (watchdog !== null) return;
	watchdog = setInterval(() => {
		if (refCount > 0 && performance.now() - lastFrameAt > STALL_MS) {
			console.warn('spectrum: no frames received — restarting capture');
			startStream();
		}
	}, STALL_MS);
}

function stopWatchdog(): void {
	if (watchdog !== null) {
		clearInterval(watchdog);
		watchdog = null;
	}
}

/** Create the Channel once and reuse it across start/stop cycles. The frame callback is held by
 * Tauri's global callback registry, so reusing one channel avoids leaking a callback per cycle. */
function ensureChannel(): Channel<SpectrumFrame> {
	if (!channel) {
		const ch = new Channel<SpectrumFrame>();
		ch.onmessage = (frame) => {
			latest = frame;
			lastFrameAt = performance.now();
			frameListeners.forEach((cb) => cb(frame));
		};
		channel = ch;
		// A page reload or window close drops this channel's JS callback, but the backend keeps
		// streaming to it ("Couldn't find callback id …" spam, plus wasted capture). Tell the backend
		// to drop our channel on the way out. Best-effort: the IPC may not flush before unload.
		if (typeof window !== 'undefined')
			window.addEventListener('beforeunload', () => {
				if (started) void invoke(COMMANDS.stopSpectrum).catch(() => undefined);
			});
		// A hidden window (minimised / occluded studio) can't show the bars, yet its subscription would
		// keep the WASAPI loopback + FFT thread busy and push 60 Hz frames into a webview nobody sees.
		// Pause the stream while hidden and resume (fresh start) when it's visible again.
		if (typeof document !== 'undefined')
			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'hidden') {
					if (started) stopStream();
				} else if (refCount > 0 && !started) startStream();
			});
	}
	return channel;
}

function startStream(): void {
	const ch = ensureChannel();
	started = true;
	// Grace the backend a full STALL_MS to produce the first frame before the watchdog retries.
	lastFrameAt = performance.now();
	startWatchdog();
	void invoke(COMMANDS.startSpectrum, {
		channel: ch,
		bands: CAPTURE_BANDS,
		device: currentDevice,
		scale: currentScale
	})
		.then(() => {
			// Released again before the start landed → undo it so we don't capture with no consumer.
			if (refCount === 0) stopStream();
		})
		.catch((err) => {
			console.warn('start_spectrum failed', err);
			started = false; // let a later acquire retry rather than wedge in a half-started state
		});
}

function stopStream(): void {
	latest = null;
	started = false;
	stopWatchdog();
	void invoke(COMMANDS.stopSpectrum).catch(() => undefined);
}

/** The process-wide spectrum source for this window. Capture starts on the first `acquire()`, stops
 * when the last subscriber releases, and restarts when the chosen device changes. */
export const spectrumSource: SpectrumSource = {
	acquire(device = '', scale = 'log') {
		refCount += 1;
		// Cancel a pending stop: this acquire is the remount of a widget that just released, so keep the
		// stream that's still running rather than tearing it down and racing a restart.
		if (stopTimer !== null) {
			clearTimeout(stopTimer);
			stopTimer = null;
		}
		// Start when nothing is running (first subscriber, or a prior start failed) or the device/scale
		// changed. A just-cancelled stop leaves the stream live (`started`), so this skips a restart.
		if (!started || device !== currentDevice || scale !== currentScale) {
			currentDevice = device;
			currentScale = scale;
			startStream();
		}
		return () => {
			refCount = Math.max(0, refCount - 1);
			// Debounced (not immediate): a drag-induced unmount→remount drops to zero for a frame or two,
			// and tearing capture down then up races the backend start/stop. Stop only if still idle later.
			if (refCount === 0 && stopTimer === null) {
				stopTimer = setTimeout(() => {
					stopTimer = null;
					if (refCount === 0) stopStream();
				}, STOP_DEBOUNCE_MS);
			}
		};
	},
	onFrame(cb) {
		frameListeners.add(cb);
		return () => {
			frameListeners.delete(cb);
		};
	},
	latestFrame() {
		return latest;
	}
};
