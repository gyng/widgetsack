import { describe, expect, it, vi } from 'vitest';
import { singleFlight } from './singleFlight';

/** A promise whose resolve/reject can be triggered from outside — lets a test pin down exactly
 * when an in-flight run "finishes" instead of racing real timers/microtasks. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('singleFlight', () => {
	it('runs the wrapped function on the first call', async () => {
		const fn = vi.fn(async () => 'value');
		const wrapped = singleFlight(fn);
		await expect(wrapped()).resolves.toBe('value');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('coalesces concurrent calls into the in-flight run plus one trailing rerun', async () => {
		const runs = [deferred<number>(), deferred<number>()];
		let calls = 0;
		const fn = vi.fn(() => runs[calls++].promise);
		const wrapped = singleFlight(fn);

		// Three calls land before the first run has settled.
		const p1 = wrapped();
		const p2 = wrapped();
		const p3 = wrapped();
		// Only the first run should have started — the other two are queued as trailing waiters.
		expect(fn).toHaveBeenCalledTimes(1);

		runs[0].resolve(1);
		await Promise.resolve(); // let the .finally() microtask kick off the trailing rerun
		await Promise.resolve();
		expect(fn).toHaveBeenCalledTimes(2); // exactly one trailing rerun, not three

		runs[1].resolve(2);
		await expect(p1).resolves.toBe(1); // the caller who started the run gets that run's result
		await expect(p2).resolves.toBe(2); // queued callers share the trailing run's result
		await expect(p3).resolves.toBe(2);
		expect(fn).toHaveBeenCalledTimes(2); // no further reruns once the queue drains
	});

	it('runs the trailing rerun exactly once even with many queued calls', async () => {
		const runs = [deferred<number>(), deferred<number>()];
		let calls = 0;
		const fn = vi.fn(() => runs[calls++].promise);
		const wrapped = singleFlight(fn);

		const waiters = [wrapped(), wrapped(), wrapped(), wrapped(), wrapped()];
		expect(fn).toHaveBeenCalledTimes(1);

		runs[0].resolve(1);
		await Promise.resolve();
		await Promise.resolve();
		expect(fn).toHaveBeenCalledTimes(2);

		runs[1].resolve(2);
		const results = await Promise.all(waiters);
		expect(results).toEqual([1, 2, 2, 2, 2]);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('propagates a rejection to the caller who started the run, without wedging the latch', async () => {
		const failure = new Error('boom');
		const fn = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce('recovered');
		const wrapped = singleFlight(fn);

		await expect(wrapped()).rejects.toBe(failure);
		expect(fn).toHaveBeenCalledTimes(1);

		// The latch must be released even after a rejection — a later call starts a fresh run.
		await expect(wrapped()).resolves.toBe('recovered');
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('rejects queued trailing waiters when the trailing rerun itself rejects', async () => {
		const first = deferred<string>();
		const failure = new Error('trailing failed');
		let calls = 0;
		const fn = vi.fn(() => {
			calls++;
			if (calls === 1) return first.promise;
			return Promise.reject(failure);
		});
		const wrapped = singleFlight(fn);

		const p1 = wrapped();
		const p2 = wrapped(); // queued — becomes the trailing rerun
		first.resolve('ok');

		await expect(p1).resolves.toBe('ok');
		await expect(p2).rejects.toBe(failure);
		expect(fn).toHaveBeenCalledTimes(2);

		// Latch released after the trailing rejection too.
		const fn2 = vi.fn(async () => 'again');
		const wrapped2 = singleFlight(fn2);
		await expect(wrapped2()).resolves.toBe('again');
	});

	it('starts a fresh run for calls that arrive after the previous run fully settled', async () => {
		const fn = vi.fn(async () => 'x');
		const wrapped = singleFlight(fn);

		await wrapped();
		await wrapped();
		await wrapped();

		expect(fn).toHaveBeenCalledTimes(3);
	});
});
