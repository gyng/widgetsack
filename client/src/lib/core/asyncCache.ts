/** Cache injected reads with one in-flight read per generation. Invalidated reads follow the current generation. */
export function asyncCache<T>(read: () => Promise<T>, now: () => number, ttl: number) {
	let cached: { value: T; at: number } | null = null;
	let pending: Promise<T> | null = null;
	let generation = 0;
	async function get(): Promise<T> {
		if (cached) {
			const age = now() - cached.at;
			if (age >= 0 && age < ttl) return cached.value;
		}
		if (pending) return pending;
		const at = generation;
		const job = read()
			.then(
				(value) => {
					if (at !== generation) return get();
					cached = { value, at: now() };
					return value;
				},
				(error) => {
					if (at !== generation) return get();
					throw error;
				}
			)
			.finally(() => {
				if (pending === job) pending = null;
			});
		pending = job;
		return job;
	}
	/** Collect related read-only data again if invalidation interrupted the snapshot. */
	async function snapshot<S>(readSnapshot: () => Promise<S>): Promise<S> {
		const at = generation;
		try {
			const value = await readSnapshot();
			if (at === generation) return value;
		} catch (error) {
			if (at === generation) throw error;
		}
		return snapshot(readSnapshot);
	}
	return {
		get,
		snapshot,
		invalidate() {
			generation++;
			cached = null;
			pending = null;
		}
	};
}
