import { describe, expect, it, vi } from 'vitest';
import { writeQueue } from './writeQueue';

describe('writeQueue', () => {
	it('coalesces adjacent previews but preserves explicit writes as barriers', async () => {
		const queue = writeQueue();
		let release!: (ok: boolean) => void;
		const order: string[] = [];
		const run = (name: string) => async () => {
			order.push(name);
			return true;
		};
		const first = queue.enqueue(
			() =>
				new Promise<boolean>((r) => {
					release = r;
				}),
			'preview'
		);
		const stale = queue.enqueue(run('stale'), 'preview');
		const latest = queue.enqueue(run('latest'), 'preview');
		const revert = queue.enqueue(run('revert'));
		const after = queue.enqueue(run('after'), 'preview');
		const flushed = queue.flush();
		expect(queue.pending()).toBe(true);
		release(true);
		expect(await Promise.all([first, stale, latest, revert, after, flushed])).toEqual(
			Array(6).fill(true)
		);
		expect(order).toEqual(['latest', 'revert', 'after']);
		expect(queue.pending()).toBe(false);
	});
	it('waits for work added during flush and retains failures until a successful retry', async () => {
		const queue = writeQueue();
		let release!: (ok: boolean) => void;
		const first = queue.enqueue(
			() =>
				new Promise<boolean>((r) => {
					release = r;
				})
		);
		const flushed = queue.flush();
		const failed = queue.enqueue(async () => false);
		release(true);
		await first;
		expect(await failed).toBe(false);
		expect(await flushed).toBe(false);
		expect(await queue.flush()).toBe(false);
		await queue.enqueue(async () => true);
		expect(await queue.flush()).toBe(true);
	});
	it('propagates exceptions and still runs later writes', async () => {
		const queue = writeQueue();
		expect(await queue.flush()).toBe(true);
		const failed = queue.enqueue(async () => {
			throw new Error('disk');
		});
		await expect(failed).rejects.toThrow('disk');
		await expect(queue.flush()).rejects.toThrow('disk');
		const retry = vi.fn(async () => true);
		expect(await queue.enqueue(retry)).toBe(true);
		expect(queue.pending()).toBe(false);
	});
});
