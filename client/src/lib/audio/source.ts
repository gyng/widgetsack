// Outer-ring adapter (AGENTS.md §5): bridges the Rust `spectrum` Channel streams into the
// per-config stream multiplexer (`spectrumMux.ts`) that Spectrum meters consume via context. The
// Tauri dependency lives here, never in the meter or in core/. Each distinct (device, scale) a meter
// asks for is its own keyed stream with its own Channel and ref count — so two meters configured
// differently never override each other — while meters with the same config share one. Capture starts
// on a stream's first meter and stops (debounced) after its last unmounts (the demand gate, mirroring
// the sensor active-set). Bridge contract: `SpectrumFrame` / `AudioDevice` mirror the Rust structs in
// widgetsack/src/audio.rs; the command names and the `key` argument must match.

import { Channel, invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../bridge/contract';
import { createSpectrumMux, type SpectrumFrame, type SpectrumSubscription } from './spectrumMux';

export type { SpectrumFrame, SpectrumSubscription } from './spectrumMux';

/** An audio output device. Mirrors `AudioDevice` in `widgetsack/src/audio.rs`. */
export type AudioDevice = { id: string; name: string };

/** What the Spectrum meter needs: a subscription to the stream for ITS config, PUSHING each frame as
 * it arrives. Push (not a rAF pull-loop) matters because the overlay is an always-on-top, transparent
 * window whose requestAnimationFrame can be throttled by the compositor — driving the draw straight
 * off the Channel message keeps it real-time. (No React state per frame — a 60 Hz setState would
 * thrash rendering; the meter paints a canvas imperatively instead.) */
export interface SpectrumSource {
	/** Keep the stream for this config running while subscribed; `device` is the output endpoint id
	 * (empty = system default), `scale` is 'log' | 'linear' band spacing. */
	acquire(device?: string, scale?: string): SpectrumSubscription;
}

/** FFT bands the backend emits. The meter groups these down to its display bar count, so capture
 * resolution is decoupled from how many bars are drawn. */
const CAPTURE_BANDS = 128;

/** One Channel per stream key, created once and reused across start/stop cycles: the frame callback
 * is held by Tauri's global callback registry, so reusing it avoids leaking a callback per cycle. */
const channels = new Map<string, Channel<SpectrumFrame>>();
let windowHooked = false;

const mux = createSpectrumMux({
	start(key, device, scale) {
		hookWindow();
		return invoke(COMMANDS.startSpectrum, {
			channel: ensureChannel(key),
			bands: CAPTURE_BANDS,
			device,
			scale,
			key
		});
	},
	stop(key) {
		void invoke(COMMANDS.stopSpectrum, { key }).catch(() => undefined);
	},
	now: () => performance.now(),
	warn: (message, detail) => console.warn(message, ...(detail === undefined ? [] : [detail]))
});

function ensureChannel(key: string): Channel<SpectrumFrame> {
	let ch = channels.get(key);
	if (!ch) {
		ch = new Channel<SpectrumFrame>();
		ch.onmessage = (frame) => mux.deliver(key, frame);
		channels.set(key, ch);
	}
	return ch;
}

function hookWindow(): void {
	if (windowHooked) return;
	windowHooked = true;
	// A page reload or window close drops our channels' JS callbacks, but the backend keeps streaming
	// to them ("Couldn't find callback id …" spam, plus wasted capture). Tell the backend to drop every
	// stream of this window on the way out (no key = all). Best-effort: the IPC may not flush.
	if (typeof window !== 'undefined')
		window.addEventListener('beforeunload', () => {
			if (mux.anyStarted()) void invoke(COMMANDS.stopSpectrum).catch(() => undefined);
		});
	// A hidden window (minimised / occluded studio) can't show the bars, yet its subscriptions would
	// keep the WASAPI loopback + FFT threads busy and push 60 Hz frames into a webview nobody sees.
	// Pause the streams while hidden and resume (fresh start) when it's visible again.
	if (typeof document !== 'undefined')
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') mux.pause();
			else mux.resume();
		});
}

/** The process-wide spectrum source for this window. */
export const spectrumSource: SpectrumSource = {
	acquire: (device, scale) => mux.acquire(device, scale)
};
