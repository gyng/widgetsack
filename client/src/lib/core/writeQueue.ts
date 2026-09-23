// Ordered async writes. Only adjacent waiting previews with the same key coalesce; an explicit
// write (no key) is a barrier, so a revert can never be overtaken by an older preview.
export function writeQueue() {
	type Entry = {
		run: () => Promise<boolean>;
		key?: string;
		waiters: { resolve: (ok: boolean) => void; reject: (error: unknown) => void }[];
	};
	const waiting: Entry[] = [];
	let running = false;
	let last: Promise<boolean> = Promise.resolve(true);
	const pump = async (): Promise<void> => {
		if (running) return;
		running = true;
		while (waiting.length) {
			const entry = waiting.shift()!;
			try {
				const ok = await entry.run();
				entry.waiters.forEach((w) => w.resolve(ok));
			} catch (error) {
				entry.waiters.forEach((w) => w.reject(error));
			}
		}
		running = false;
	};
	return {
		enqueue(run: () => Promise<boolean>, key?: string): Promise<boolean> {
			last = new Promise<boolean>((resolve, reject) => {
				const tail = waiting.at(-1);
				if (key !== undefined && tail?.key === key) {
					tail.run = run;
					tail.waiters.push({ resolve, reject });
				} else {
					waiting.push({ run, key, waiters: [{ resolve, reject }] });
				}
			});
			void pump();
			return last;
		},
		async flush(): Promise<boolean> {
			// Include writes queued while a caller was waiting, and retain a failed outcome until retried.
			for (;;) {
				const tail = last;
				const ok = await tail;
				if (tail === last) return ok;
			}
		},
		pending: () => running || waiting.length > 0
	};
}
