export type ScrollClock = { at: number; phase: number; samples?: number };

// Fast Refresh preserves refs created by earlier code; never let an old counter blank the canvas.
const sampleCount = (clock: ScrollClock): number =>
	Number.isFinite(clock.samples) ? Number(clock.samples) : 0;

/** A continuous horizontal phase; an early sample starts just outside the right edge. */
export function scrollAt(clock: ScrollClock, now: number): number {
	const elapsed = Math.max(0, now - clock.at) / 1000;
	return Math.min(1, clock.phase + elapsed * (1 - clock.phase));
}

export function nextScroll(clock: ScrollClock | null, now: number, sameSeries = true): ScrollClock {
	return {
		at: now,
		phase: clock && sameSeries ? Math.max(-1, scrollAt(clock, now) - 1) : 0,
		samples: clock && sameSeries ? sampleCount(clock) + 1 : 0
	};
}

/** Quantize the camera, not each sample's local offset. The absolute sample index keeps
 * antialiasing identical when a fractional-width slot crosses a telemetry boundary. */
export function pixelScrollOffset(clock: ScrollClock, phase: number, slot: number): number {
	const samples = sampleCount(clock);
	return samples * slot - Math.round((samples + phase) * slot);
}
