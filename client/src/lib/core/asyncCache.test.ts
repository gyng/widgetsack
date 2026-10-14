import { expect, it, vi } from 'vitest';
import { asyncCache } from './asyncCache';
it('returns the new generation to old callers and never restores an invalidated snapshot', async () => {
	let finish!: (value: string) => void;
	const read = vi
		.fn()
		.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					finish = resolve;
				})
		)
		.mockResolvedValue('fresh');
	const cache = asyncCache<string>(read, () => 0, 60);
	const old = cache.get();
	cache.invalidate();
	expect(await cache.get()).toBe('fresh');
	finish('old');
	expect(await old).toBe('fresh');
	expect(await cache.get()).toBe('fresh');
});

it('shares concurrent reads and starts TTL at completion, including clock rollback recovery', async () => {
	let time = 0;
	let finish!: (value: string) => void;
	const read = vi
		.fn()
		.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					finish = resolve;
				})
		)
		.mockResolvedValue('next');
	const cache = asyncCache<string>(read, () => time, 60);
	const first = cache.get(),
		second = cache.get();
	expect(read).toHaveBeenCalledTimes(1);
	time = 100;
	finish('first');
	expect(await Promise.all([first, second])).toEqual(['first', 'first']);
	time = 159;
	expect(await cache.get()).toBe('first');
	time = 160;
	expect(await cache.get()).toBe('next');
	time = 150;
	await cache.get();
	expect(read).toHaveBeenCalledTimes(3);
});
it('retries current read failures', async () => {
	const error = new Error('read failed');
	const read = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('good');
	const cache = asyncCache<string>(read, () => 0, 60);
	await expect(cache.get()).rejects.toBe(error);
	expect(await cache.get()).toBe('good');
});
it('does not expose an invalidated read error to old callers', async () => {
	let fail!: (error: Error) => void;
	const read = vi
		.fn()
		.mockImplementationOnce(
			() =>
				new Promise<string>((_, reject) => {
					fail = reject;
				})
		)
		.mockResolvedValue('fresh');
	const cache = asyncCache<string>(read, () => 0, 60);
	const old = cache.get();
	cache.invalidate();
	const fresh = cache.get();
	fail(new Error('obsolete'));
	expect(await Promise.all([old, fresh])).toEqual(['fresh', 'fresh']);
});

it.each(['value', 'error'] as const)(
	'recollects related geometry when invalidation interrupts a snapshot %s',
	async (outcome) => {
		let finish!: (value: string) => void;
		let fail!: (error: Error) => void;
		const read = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<string>((resolve, reject) => {
						finish = resolve;
						fail = reject;
					})
			)
			.mockResolvedValue('fresh geometry');
		const cache = asyncCache(
			async () => 'ids',
			() => 0,
			60
		);
		const old = cache.snapshot(read);
		cache.invalidate();
		if (outcome === 'value') finish('old geometry');
		else fail(new Error('obsolete geometry read'));
		expect(await old).toBe('fresh geometry');
		expect(read).toHaveBeenCalledTimes(2);
	}
);
it('propagates a snapshot failure when the generation is still current', async () => {
	const error = new Error('current snapshot failed');
	const cache = asyncCache(
		async () => 'ids',
		() => 0,
		60
	);
	await expect(
		cache.snapshot(async () => {
			throw error;
		})
	).rejects.toBe(error);
});
