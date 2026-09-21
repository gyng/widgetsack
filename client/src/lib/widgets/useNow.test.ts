import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { nowSnapshot, subscribeNow, useNow } from './useNow';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2027-01-01T12:00:00.400Z'));
});
afterEach(() => {
	vi.useRealTimers();
});

const T0 = Date.parse('2027-01-01T12:00:00.400Z');

describe('useNow', () => {
	it('ticks on the period BOUNDARY, not a whole period after mount', () => {
		const { result } = renderHook(() => useNow(1000));
		expect(result.current).toBe(T0);
		// 400 ms into the second: the first tick lands at :01.000 (600 ms away), not at :01.400.
		act(() => vi.advanceTimersByTime(599));
		expect(result.current).toBe(T0);
		act(() => vi.advanceTimersByTime(1));
		expect(result.current).toBe(T0 + 600);
		// …and every period after that, still on the boundary.
		act(() => vi.advanceTimersByTime(1000));
		expect(result.current).toBe(T0 + 1600);
	});

	it('shares ONE timer among every subscriber of the same period and flips them together', () => {
		const a = renderHook(() => useNow(1000));
		const b = renderHook(() => useNow(1000));
		const c = renderHook(() => useNow(60_000));
		expect(vi.getTimerCount()).toBe(2); // one per distinct period, not per hook
		act(() => vi.advanceTimersByTime(600));
		expect(a.result.current).toBe(T0 + 600);
		expect(b.result.current).toBe(T0 + 600);
		expect(c.result.current).toBe(T0); // the minute clock hasn't reached :01:00 yet
		// The last subscriber of a period leaving tears its timer down (no idle wake-ups).
		a.unmount();
		expect(vi.getTimerCount()).toBe(2);
		b.unmount();
		expect(vi.getTimerCount()).toBe(1);
		c.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('a period ≤ 0 disables the clock: returns 0 and arms nothing', () => {
		const { result, rerender } = renderHook((p: number) => useNow(p), { initialProps: 0 });
		expect(result.current).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		// Switching to a live period (a timer that starts running) subscribes from a fresh snapshot.
		rerender(250);
		expect(result.current).toBe(T0);
		expect(vi.getTimerCount()).toBe(1);
		rerender(0);
		expect(result.current).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('subscribeNow / nowSnapshot seams', () => {
	it('unsubscribing twice is harmless and cannot tear down a clock others still use', () => {
		const first = subscribeNow(1000, () => undefined);
		const second = subscribeNow(1000, () => undefined);
		first();
		first(); // already gone → no-op (the second subscriber keeps the clock alive)
		expect(vi.getTimerCount()).toBe(1);
		second();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('an idle clock (read before any subscriber) refreshes once it is a period old', () => {
		expect(nowSnapshot(1000)).toBe(T0);
		vi.setSystemTime(T0 + 500);
		expect(nowSnapshot(1000)).toBe(T0); // stable within the period
		vi.setSystemTime(T0 + 1000);
		expect(nowSnapshot(1000)).toBe(T0 + 1000);
		// Same value on an immediate re-read (useSyncExternalStore's consistency requirement).
		expect(nowSnapshot(1000)).toBe(T0 + 1000);
		expect(nowSnapshot(0)).toBe(0);
	});

	it('a subscriber that unsubscribes inside its own tick stops the clock re-arming', () => {
		const off = subscribeNow(1000, () => off());
		act(() => vi.advanceTimersByTime(600));
		expect(vi.getTimerCount()).toBe(0);
	});
});
