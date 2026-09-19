import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTimer, type TimerConfig } from './useTimer';

beforeEach(() => {
	vi.useFakeTimers({ now: 1_000_000 });
	localStorage.clear();
});
afterEach(() => {
	localStorage.clear();
	vi.useRealTimers();
});

const advance = (ms: number): void => {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
};

describe('useTimer countdown', () => {
	it('starts idle at the full duration and is not done', () => {
		const { result } = renderHook(() => useTimer({ mode: 'countdown', duration: 10 }));
		expect(result.current.seconds).toBe(10);
		expect(result.current.running).toBe(false);
		expect(result.current.done).toBe(false);
	});

	it('counts down while running', () => {
		const { result } = renderHook(() => useTimer({ mode: 'countdown', duration: 10 }));
		act(() => result.current.start());
		expect(result.current.running).toBe(true);
		advance(3000);
		expect(result.current.seconds).toBeCloseTo(7, 5);
	});

	it('start() is a no-op when already running (does not reset the anchor)', () => {
		const { result } = renderHook(() => useTimer({ mode: 'countdown', duration: 10 }));
		act(() => result.current.start());
		advance(2000);
		act(() => result.current.start()); // ignored — anchor stays put
		advance(1000);
		expect(result.current.seconds).toBeCloseTo(7, 5);
	});

	it('pause() freezes elapsed time and resumes from there', () => {
		const { result } = renderHook(() => useTimer({ mode: 'countdown', duration: 10 }));
		act(() => result.current.start());
		advance(2000);
		act(() => result.current.pause());
		expect(result.current.running).toBe(false);
		expect(result.current.seconds).toBeCloseTo(8, 5);
		// Time passing while paused must NOT advance the count.
		advance(5000);
		expect(result.current.seconds).toBeCloseTo(8, 5);
		// Resume continues from the frozen accumulator.
		act(() => result.current.start());
		advance(1000);
		expect(result.current.seconds).toBeCloseTo(7, 5);
	});

	it('pause() is a no-op when already paused', () => {
		const { result } = renderHook(() => useTimer({ mode: 'countdown', duration: 10 }));
		act(() => result.current.pause()); // already stopped — no change
		expect(result.current.running).toBe(false);
		expect(result.current.seconds).toBe(10);
	});

	it('toggle() flips between running and paused', () => {
		const { result } = renderHook(() => useTimer({ mode: 'countdown', duration: 10 }));
		act(() => result.current.toggle());
		expect(result.current.running).toBe(true);
		act(() => result.current.toggle());
		expect(result.current.running).toBe(false);
	});

	it('reset() while paused clears the accumulator (and keeps the timer stopped)', () => {
		const { result } = renderHook(() => useTimer({ mode: 'countdown', duration: 10 }));
		act(() => result.current.start());
		advance(4000);
		act(() => result.current.pause());
		expect(result.current.seconds).toBeCloseTo(6, 5);
		act(() => result.current.reset());
		expect(result.current.seconds).toBe(10);
		expect(result.current.running).toBe(false);
	});

	it('reset() while running re-anchors to now and starts the full duration again', () => {
		const { result } = renderHook(() => useTimer({ mode: 'countdown', duration: 10 }));
		act(() => result.current.start());
		advance(4000);
		act(() => result.current.reset());
		expect(result.current.running).toBe(true);
		expect(result.current.seconds).toBeCloseTo(10, 5);
		advance(1000);
		expect(result.current.seconds).toBeCloseTo(9, 5);
	});

	it('auto-stops frozen exactly at zero when the countdown completes (no loop)', () => {
		const { result } = renderHook(() => useTimer({ mode: 'countdown', duration: 2, loop: false }));
		act(() => result.current.start());
		advance(2500); // past the end
		expect(result.current.seconds).toBe(0);
		expect(result.current.done).toBe(true);
		expect(result.current.running).toBe(false);
		// Stays frozen at 0 even as more time elapses.
		advance(2000);
		expect(result.current.seconds).toBe(0);
	});

	it('loops back to the full duration when loop is set', () => {
		const { result } = renderHook(() => useTimer({ mode: 'countdown', duration: 2, loop: true }));
		act(() => result.current.start());
		advance(2100); // crosses zero → restarts
		expect(result.current.running).toBe(true);
		// Re-anchored: close to the full duration again, still counting.
		expect(result.current.seconds).toBeGreaterThan(1.5);
		expect(result.current.seconds).toBeLessThanOrEqual(2);
	});

	it('a zero-duration countdown is never "done" (guards the divide-by-nothing edge)', () => {
		const { result } = renderHook(() => useTimer({ mode: 'countdown', duration: 0 }));
		act(() => result.current.start());
		advance(1000);
		expect(result.current.done).toBe(false);
	});
});

describe('useTimer stopwatch', () => {
	it('counts up from zero while running', () => {
		const { result } = renderHook(() => useTimer({ mode: 'stopwatch', duration: 0 }));
		expect(result.current.seconds).toBe(0);
		act(() => result.current.start());
		advance(3000);
		expect(result.current.seconds).toBeCloseTo(3, 5);
		expect(result.current.done).toBe(false);
	});

	it('reset() zeroes the elapsed count', () => {
		const cfg: TimerConfig = { mode: 'stopwatch', duration: 0 };
		const { result } = renderHook(() => useTimer(cfg));
		act(() => result.current.start());
		advance(5000);
		act(() => result.current.reset());
		expect(result.current.seconds).toBeCloseTo(0, 5);
	});
});

describe('useTimer persistence and synchronization', () => {
	it('recovers from malformed and structurally invalid persisted state', () => {
		localStorage.setItem('bad-json', '{');
		const malformed = renderHook(() =>
			useTimer({ mode: 'countdown', duration: 10, storageKey: 'bad-json' })
		);
		expect(malformed.result.current.seconds).toBe(10);
		malformed.unmount();

		localStorage.setItem(
			'bad-runtime',
			JSON.stringify({
				version: 1,
				config: 'countdown:10:0',
				runtime: { running: 'yes', accumulatedMs: 0, startedAt: null }
			})
		);
		const invalid = renderHook(() =>
			useTimer({ mode: 'countdown', duration: 10, storageKey: 'bad-runtime' })
		);
		expect(invalid.result.current.running).toBe(false);
		expect(invalid.result.current.seconds).toBe(10);

		localStorage.setItem(
			'null-runtime',
			JSON.stringify({ version: 1, config: 'countdown:10:0', runtime: null })
		);
		const missing = renderHook(() =>
			useTimer({ mode: 'countdown', duration: 10, storageKey: 'null-runtime' })
		);
		expect(missing.result.current.seconds).toBe(10);
	});

	it('continues a running timer across unmount and remount', () => {
		const cfg: TimerConfig = { mode: 'stopwatch', duration: 0, storageKey: 'timer-a' };
		const first = renderHook(() => useTimer(cfg));
		act(() => first.result.current.start());
		advance(2000);
		first.unmount();
		advance(3000);
		const second = renderHook(() => useTimer(cfg));
		expect(second.result.current.running).toBe(true);
		expect(second.result.current.seconds).toBeCloseTo(5, 5);
	});

	it('synchronizes controls between two mounted copies of the same widget', () => {
		const cfg: TimerConfig = { mode: 'countdown', duration: 10, storageKey: 'timer-shared' };
		const first = renderHook(() => useTimer(cfg));
		const second = renderHook(() => useTimer(cfg));
		act(() => first.result.current.start());
		expect(second.result.current.running).toBe(true);
		advance(2000);
		act(() => second.result.current.pause());
		expect(first.result.current.running).toBe(false);
		expect(first.result.current.seconds).toBeCloseTo(8, 5);
		act(() => first.result.current.reset());
		expect(second.result.current.seconds).toBe(10);
	});

	it('resets persisted state when the timer configuration changes', () => {
		const { result, rerender } = renderHook(
			({ duration }) =>
				useTimer({ mode: 'countdown', duration, storageKey: 'timer-config-change' }),
			{ initialProps: { duration: 10 } }
		);
		act(() => result.current.start());
		advance(3000);
		rerender({ duration: 20 });
		expect(result.current.running).toBe(false);
		expect(result.current.seconds).toBe(20);
	});

	it('accepts valid storage events and ignores unrelated or malformed ones', () => {
		const cfg: TimerConfig = { mode: 'stopwatch', duration: 0, storageKey: 'timer-storage' };
		const { result } = renderHook(() => useTimer(cfg));

		act(() => {
			window.dispatchEvent(
				new StorageEvent('storage', {
					key: 'another-timer',
					newValue: JSON.stringify({})
				})
			);
			window.dispatchEvent(new StorageEvent('storage', { key: 'timer-storage', newValue: null }));
			window.dispatchEvent(
				new StorageEvent('storage', { key: 'timer-storage', newValue: '{not json' })
			);
			window.dispatchEvent(
				new StorageEvent('storage', {
					key: 'timer-storage',
					newValue: JSON.stringify({
						version: 2,
						config: 'stopwatch:0:0',
						runtime: { running: true, accumulatedMs: 3000, startedAt: 1_000_000 }
					})
				})
			);
		});
		expect(result.current.running).toBe(false);

		act(() => {
			window.dispatchEvent(
				new StorageEvent('storage', {
					key: 'timer-storage',
					newValue: JSON.stringify({
						version: 1,
						config: 'stopwatch:0:0',
						runtime: { running: true, accumulatedMs: 3000, startedAt: 1_000_000 }
					})
				})
			);
		});
		expect(result.current.running).toBe(true);
		expect(result.current.seconds).toBeCloseTo(3, 5);
	});

	it('ignores timer synchronization events for another key or invalid runtime', () => {
		const { result } = renderHook(() =>
			useTimer({ mode: 'stopwatch', duration: 0, storageKey: 'timer-events' })
		);
		act(() => {
			window.dispatchEvent(
				new CustomEvent('widgetsack:timer-state', {
					detail: {
						storageKey: 'another-timer',
						config: 'stopwatch:0:0',
						runtime: { running: true, accumulatedMs: 5000, startedAt: 1_000_000 }
					}
				})
			);
			window.dispatchEvent(
				new CustomEvent('widgetsack:timer-state', {
					detail: {
						storageKey: 'timer-events',
						config: 'stopwatch:0:0',
						runtime: null
					}
				})
			);
		});
		expect(result.current.running).toBe(false);
		expect(result.current.seconds).toBe(0);
	});
});
