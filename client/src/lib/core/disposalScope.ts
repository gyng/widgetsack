// Own synchronous cleanup handles, including resources acquired after cancellation.
export function disposalScope(onError: (error: unknown) => void) {
	let disposed = false;
	const cleanups: (() => void)[] = [];
	const release = (cleanup: () => void): void => {
		try {
			cleanup();
		} catch (error) {
			onError(error);
		}
	};
	return {
		get disposed() {
			return disposed;
		},
		add(cleanup: () => void): void {
			if (disposed) release(cleanup);
			else cleanups.push(cleanup);
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			while (cleanups.length) release(cleanups.pop()!);
		}
	};
}
