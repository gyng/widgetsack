import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useSettingsOperations } from './useSettingsOperations';
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
it('does not mark a changed form saved or clear its newer secret', async () => {
	const { result } = renderHook(useSettingsOperations);
	const pending = deferred<void>();
	const apply = vi.fn();
	let saving!: Promise<void>;
	act(() => {
		saving = result.current.save(() => pending.promise, apply);
	});
	act(() => result.current.invalidate());
	await act(async () => {
		pending.resolve();
		await saving;
	});
	expect(apply).not.toHaveBeenCalled();
	expect(result.current.saved).toBe(false);
	expect(result.current.saving).toBe(false);
});
it('rejects overlapping saves and exposes current failures without an unhandled rejection', async () => {
	const { result } = renderHook(useSettingsOperations);
	const pending = deferred<void>();
	const second = vi.fn();
	let saving!: Promise<void>;
	act(() => {
		saving = result.current.save(() => pending.promise);
	});
	await act(async () => {
		await result.current.save(second);
	});
	expect(second).not.toHaveBeenCalled();
	await act(async () => {
		pending.reject(new Error('disk full'));
		await saving;
	});
	expect(result.current.error).toBe('disk full');
	expect(result.current.saving).toBe(false);
});
it('ignores stale tests, initial loads, and completions after unmount', async () => {
	const { result, unmount } = renderHook(useSettingsOperations);
	const old = deferred<string>();
	const apply = vi.fn();
	const current = result.current.capture();
	let work!: Promise<void>;
	act(() => {
		work = result.current.latest('test', () => old.promise, apply);
	});
	act(() => result.current.invalidate());
	expect(current()).toBe(false);
	await act(async () => {
		old.resolve('old');
		await work;
	});
	expect(apply).not.toHaveBeenCalled();
	const last = deferred<string>();
	act(() => {
		work = result.current.latest('test', () => last.promise, apply);
	});
	unmount();
	await act(async () => {
		last.resolve('unmounted');
		await work;
	});
	expect(apply).not.toHaveBeenCalled();
});
it('only applies the newest result within a request category', async () => {
	const { result } = renderHook(useSettingsOperations);
	const old = deferred<string>();
	const apply = vi.fn();
	const first = result.current.latest('models', () => old.promise, apply);
	await result.current.latest('models', async () => 'new', apply);
	old.resolve('old');
	await first;
	expect(apply).toHaveBeenCalledExactlyOnceWith('new');
});

it('ignores failed saves and probes after the form changes', async () => {
	const { result } = renderHook(useSettingsOperations);
	const failed = vi.fn();
	const a = deferred<void>();
	const b = deferred<void>();
	let saving!: Promise<void>;
	let probe!: Promise<void>;
	act(() => {
		saving = result.current.save(() => a.promise);
		probe = result.current.latest('test', () => b.promise, vi.fn(), failed);
		result.current.invalidate();
	});
	await act(async () => {
		a.reject('old save');
		b.reject('old probe');
		await Promise.all([saving, probe]);
	});
	expect(result.current.error).toBeNull();
	expect(failed).not.toHaveBeenCalled();
});
