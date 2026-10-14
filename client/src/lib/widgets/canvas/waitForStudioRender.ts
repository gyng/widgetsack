export async function waitForStudioRender(signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw new Error('Verification was cancelled.');
	if (document.visibilityState === 'hidden') return;
	await new Promise<void>((resolve, reject) => {
		let frame = 0;
		const done = (error?: Error) => {
			cancelAnimationFrame(frame);
			document.removeEventListener('visibilitychange', visibilityChanged);
			signal?.removeEventListener('abort', abort);
			if (error) reject(error);
			else resolve();
		};
		const abort = () => done(new Error('Verification was cancelled.'));
		const visibilityChanged = () => {
			if (document.visibilityState === 'hidden') done();
		};
		document.addEventListener('visibilitychange', visibilityChanged);
		signal?.addEventListener('abort', abort, { once: true });
		frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(() => done());
		});
	});
}
