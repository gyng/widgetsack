// One shared, boundary-aligned wall clock per window. Every time widget (Clock, AnalogClock,
// Countdown, Timer, Agenda, Calendar, SunMoon) used to own a `setInterval` — a dozen widgets meant a
// dozen unaligned timers waking the webview at random offsets, each tick a separate React commit.
// Here all subscribers of one period share ONE `setTimeout` that fires on the next period boundary
// (a 1 s clock ticks at :00.000, not 400 ms after mount), so every clock on the overlay flips in the
// same commit and the display never lags the true second by up to a whole tick. Timers are created
// on the first subscriber and torn down with the last (no idle wake-ups).
//
// `useNow(periodMs)` returns the epoch ms of the latest tick via useSyncExternalStore; a period ≤ 0
// disables the tick (returns 0, subscribes nothing) for consumers that only need the clock while
// active — e.g. a running timer. The plain `subscribeNow` / `nowSnapshot` seams are exported for
// tests and non-React callers.
import { useCallback, useSyncExternalStore } from 'react';

type Clock = {
	subs: Set<() => void>;
	timer: ReturnType<typeof setTimeout> | null;
	/** Epoch ms of the latest tick (the snapshot every subscriber renders from). */
	now: number;
};

const clocks = new Map<number, Clock>();

const clockFor = (period: number): Clock => {
	let clock = clocks.get(period);
	if (!clock) {
		clock = { subs: new Set(), timer: null, now: Date.now() };
		clocks.set(period, clock);
	}
	return clock;
};

/** Arm the next tick at the coming period boundary (a delay in (0, period]). */
const arm = (period: number, clock: Clock): void => {
	const delay = period - (Date.now() % period);
	clock.timer = setTimeout(() => {
		clock.timer = null;
		clock.now = Date.now();
		clock.subs.forEach((cb) => cb());
		// A callback may have unsubscribed the last consumer; only a live clock re-arms.
		if (clock.subs.size > 0) arm(period, clock);
	}, delay);
};

/** Subscribe `cb` to the `period` clock. The first subscriber starts its timer; the last one leaving
 * clears it and forgets the clock. Returns the unsubscribe function. */
export function subscribeNow(periodMs: number, cb: () => void): () => void {
	const period = Math.round(periodMs);
	if (period <= 0) return () => undefined;
	const clock = clockFor(period);
	clock.subs.add(cb);
	if (clock.timer === null) arm(period, clock);
	return () => {
		if (!clock.subs.delete(cb) || clock.subs.size > 0) return;
		if (clock.timer !== null) clearTimeout(clock.timer);
		clock.timer = null;
		clocks.delete(period);
	};
}

/** The latest tick of the `period` clock (epoch ms). Stable between ticks, as useSyncExternalStore
 * requires. An IDLE clock (no subscriber yet — e.g. read during a render that hasn't committed) is
 * refreshed once it is a full period old, so a consumer never starts from a stale minute. */
export function nowSnapshot(periodMs: number): number {
	const period = Math.round(periodMs);
	if (period <= 0) return 0;
	const clock = clockFor(period);
	if (clock.timer === null && Date.now() - clock.now >= period) clock.now = Date.now();
	return clock.now;
}

export function useNow(periodMs: number): number {
	const subscribe = useCallback((cb: () => void) => subscribeNow(periodMs, cb), [periodMs]);
	const getSnapshot = useCallback(() => nowSnapshot(periodMs), [periodMs]);
	return useSyncExternalStore(subscribe, getSnapshot);
}
