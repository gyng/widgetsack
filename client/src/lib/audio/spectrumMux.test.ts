import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createSpectrumMux,
	normalizeScale,
	spectrumKey,
	STALL_MS,
	STOP_DEBOUNCE_MS,
	type SpectrumFrame,
	type SpectrumMuxDeps
} from './spectrumMux';

const frame = (v: number): SpectrumFrame => ({ bands: [v], rms: v, ts_ms: v });

function harness(startImpl?: () => Promise<unknown>) {
	let now = 0;
	const starts: string[] = [];
	const stops: string[] = [];
	const deps: SpectrumMuxDeps = {
		start: vi.fn((key: string) => {
			starts.push(key);
			return startImpl ? startImpl() : Promise.resolve();
		}),
		stop: vi.fn((key: string) => {
			stops.push(key);
		}),
		now: () => now,
		warn: vi.fn()
	};
	const mux = createSpectrumMux(deps);
	const advance = async (ms: number) => {
		now += ms;
		await vi.advanceTimersByTimeAsync(ms);
	};
	return { mux, deps, starts, stops, advance };
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('spectrum stream keys', () => {
	it('normalises the scale and keys by scale + device', () => {
		expect(normalizeScale('linear')).toBe('linear');
		expect(normalizeScale('log')).toBe('log');
		expect(normalizeScale(undefined)).toBe('log');
		expect(normalizeScale('bogus')).toBe('log');
		expect(spectrumKey('', 'log')).toBe('log|');
		expect(spectrumKey('{0.0.0}.{abc}', 'linear')).toBe('linear|{0.0.0}.{abc}');
	});
});

describe('createSpectrumMux', () => {
	it('gives differently configured meters their own streams and frames (no last-start-wins)', async () => {
		const { mux, deps, starts } = harness();
		const a = mux.acquire('hdmi', 'linear');
		const b = mux.acquire('', 'log');
		expect(starts).toEqual(['linear|hdmi', 'log|']);
		expect(deps.start).toHaveBeenCalledWith('linear|hdmi', 'hdmi', 'linear');
		expect(deps.start).toHaveBeenCalledWith('log|', '', 'log');
		await vi.advanceTimersByTimeAsync(0);

		const gotA: SpectrumFrame[] = [];
		const gotB: SpectrumFrame[] = [];
		a.onFrame((f) => gotA.push(f));
		b.onFrame((f) => gotB.push(f));
		mux.deliver('linear|hdmi', frame(1));
		mux.deliver('log|', frame(2));
		expect(gotA).toEqual([frame(1)]);
		expect(gotB).toEqual([frame(2)]);
		expect(a.latestFrame()).toEqual(frame(1));
		expect(b.latestFrame()).toEqual(frame(2));
	});

	it('shares one stream between same-config meters and stops it (debounced) after the last leaves', async () => {
		const { mux, starts, stops, advance } = harness();
		const a = mux.acquire('', 'log');
		const b = mux.acquire('', undefined);
		expect(starts).toEqual(['log|']);
		await advance(0);

		a.release();
		a.release(); // idempotent: must not steal b's reference
		b.release();
		await advance(STOP_DEBOUNCE_MS - 1);
		expect(stops).toEqual([]);
		await advance(1);
		expect(stops).toEqual(['log|']);
		expect(mux.anyStarted()).toBe(false);
	});

	it('keeps the stream through a quick release → re-acquire (drag remount)', async () => {
		const { mux, starts, stops, advance } = harness();
		const first = mux.acquire('dev');
		await advance(0); // the start has landed
		first.release();
		await advance(STOP_DEBOUNCE_MS / 2);
		const again = mux.acquire('dev');
		await advance(STOP_DEBOUNCE_MS * 2);
		expect(starts).toEqual(['log|dev']);
		expect(stops).toEqual([]);
		again.release();
	});

	it('releasing one config leaves the other stream running', async () => {
		const { mux, stops, advance } = harness();
		const a = mux.acquire('a');
		const b = mux.acquire('b');
		await advance(0);
		a.release();
		await advance(STOP_DEBOUNCE_MS);
		expect(stops).toEqual(['log|a']);
		const got: SpectrumFrame[] = [];
		b.onFrame((f) => got.push(f));
		mux.deliver('log|b', frame(3));
		mux.deliver('log|a', frame(4)); // stopped stream: dropped
		mux.deliver('nope', frame(5));
		expect(got).toEqual([frame(3)]);
		expect(a.latestFrame()).toBeNull();
	});

	it('undoes a start that lands after every subscriber already left', async () => {
		let resolve!: () => void;
		const { mux, stops } = harness(() => new Promise<void>((r) => (resolve = r)));
		mux.acquire('x').release();
		resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(stops).toEqual(['log|x']);
		// The pending debounce was settled with it: no second stop later.
		await vi.advanceTimersByTimeAsync(STOP_DEBOUNCE_MS);
		expect(stops).toEqual(['log|x']);
	});

	it('unsubscribes frame callbacks individually and on release', async () => {
		const { mux, advance } = harness();
		const sub = mux.acquire();
		const other = mux.acquire();
		await advance(0);
		const cb = vi.fn();
		const cb2 = vi.fn();
		const off = sub.onFrame(cb);
		sub.onFrame(cb2);
		const keep = vi.fn();
		other.onFrame(keep);
		off();
		mux.deliver('log|', frame(1));
		expect(cb).not.toHaveBeenCalled();
		expect(cb2).toHaveBeenCalledTimes(1);
		sub.release();
		mux.deliver('log|', frame(2));
		expect(cb2).toHaveBeenCalledTimes(1);
		expect(keep).toHaveBeenCalledTimes(2);
	});

	it('restarts only the stalled stream, and retries a failed start', async () => {
		let fail = true;
		const { mux, deps, starts, advance } = harness(() =>
			fail ? Promise.reject(new Error('boom')) : Promise.resolve()
		);
		mux.acquire('a');
		await advance(0);
		expect(deps.warn).toHaveBeenCalledWith('start_spectrum failed', expect.any(Error));
		expect(mux.anyStarted()).toBe(false);
		fail = false;
		mux.acquire('b');
		await advance(0);

		// b keeps receiving frames; a (failed) gets nothing → only a is restarted.
		for (let t = 0; t < STALL_MS * 2; t += 500) {
			mux.deliver('log|b', frame(t));
			await advance(500);
		}
		expect(starts).toEqual(['log|a', 'log|b', 'log|a']);
		expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('log|a'));
	});

	it('pauses every stream while hidden and resumes those still subscribed', async () => {
		const { mux, starts, stops, advance } = harness();
		const live = mux.acquire('live');
		mux.acquire('leaving').release(); // pending debounced stop
		await advance(0);

		mux.pause();
		expect(stops.sort()).toEqual(['log|leaving', 'log|live']);
		expect(mux.anyStarted()).toBe(false);
		// Mounted while hidden: nothing starts, and the watchdog doesn't fight the pause.
		const late = mux.acquire('late');
		await advance(STALL_MS * 2);
		expect(starts).toEqual(['log|live', 'log|leaving']);

		mux.resume();
		expect(starts).toEqual(['log|live', 'log|leaving', 'log|live', 'log|late']);
		expect(mux.anyStarted()).toBe(true);
		live.release();
		late.release();
		await advance(STOP_DEBOUNCE_MS);
		expect(mux.anyStarted()).toBe(false);
	});
});
