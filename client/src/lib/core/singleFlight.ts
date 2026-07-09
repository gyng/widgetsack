// Pure promise bookkeeping: no timers, no I/O, no Tauri. Unit-tested directly.

/**
 * Wrap an async `fn` so concurrent calls collapse into at most two executions: the run already
 * in flight, plus — if any calls arrived while it was running — exactly one trailing rerun once
 * it settles. Callers that arrive mid-run don't start their own run; they all resolve/reject
 * together with the trailing rerun's outcome (the caller that kicked off the in-flight run still
 * gets that run's own outcome). A call that arrives after the previous run (and any trailing
 * rerun) has fully settled always starts a fresh run — this is single-flight, not a debounce.
 *
 * Use this to guard an operation that snapshots external state and mutates it (e.g. reconciling
 * windows against a saved layout) from being re-entered while a previous pass is still applying
 * its snapshot, without dropping a change that arrived mid-pass.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
	let current: Promise<T> | null = null;
	let trailingWaiters:
		| { resolve: (value: T) => void; reject: (reason?: unknown) => void }[]
		| null = null;

	const start = (): Promise<T> => {
		const run = fn().finally(() => {
			current = null;
			if (trailingWaiters) {
				const waiters = trailingWaiters;
				trailingWaiters = null;
				start().then(
					(value) => waiters.forEach((w) => w.resolve(value)),
					(err) => waiters.forEach((w) => w.reject(err))
				);
			}
		});
		current = run;
		return run;
	};

	return (): Promise<T> => {
		if (current) {
			if (!trailingWaiters) trailingWaiters = [];
			return new Promise<T>((resolve, reject) => {
				trailingWaiters!.push({ resolve, reject });
			});
		}
		return start();
	};
}
