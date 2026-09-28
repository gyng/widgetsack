import { describe, expect, it, vi } from 'vitest';
import { disposalScope } from './disposalScope';

describe('disposalScope', () => {
	it('releases resources once in reverse acquisition order and includes late resources', async () => {
		const calls: string[] = [];
		const scope = disposalScope(vi.fn());
		scope.add(() => calls.push('first'));
		scope.add(() => calls.push('second'));
		let finish!: (stop: () => void) => void;
		const acquired = new Promise<() => void>((resolve) => {
			finish = resolve;
		}).then(scope.add);
		scope.dispose();
		finish(() => calls.push('late'));
		await acquired;
		scope.dispose();
		expect(calls).toEqual(['second', 'first', 'late']);
		expect(scope.disposed).toBe(true);
	});
	it('continues releasing resources when a cleanup throws', () => {
		const error = new Error('cleanup failed');
		const report = vi.fn();
		const stop = vi.fn();
		const scope = disposalScope(report);
		scope.add(stop);
		scope.add(() => {
			throw error;
		});
		scope.dispose();
		expect(stop).toHaveBeenCalledOnce();
		expect(report).toHaveBeenCalledWith(error);
	});
});
