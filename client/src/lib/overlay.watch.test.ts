import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { availableMonitors, type Monitor } from '@tauri-apps/api/window';
import { watchDisplayChanges } from './overlay';

vi.mock('@tauri-apps/api/window', async (original) => ({
	...(await original<typeof import('@tauri-apps/api/window')>()),
	availableMonitors: vi.fn(async () => [])
}));

let stop: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(availableMonitors).mockReset().mockResolvedValue([]);
});
afterEach(() => {
	stop?.();
	vi.useRealTimers();
});

it('does not reconcile after stopping during monitor enumeration', async () => {
	const reconcile = vi.fn(async () => undefined);
	stop = watchDisplayChanges(vi.fn(), undefined, reconcile);
	await vi.advanceTimersByTimeAsync(0);
	let resolve!: (monitors: Monitor[]) => void;
	vi.mocked(availableMonitors).mockImplementationOnce(() => new Promise((r) => (resolve = r)));
	await vi.advanceTimersByTimeAsync(4000);
	stop();
	resolve([]);
	await vi.advanceTimersByTimeAsync(0);
	expect(reconcile).not.toHaveBeenCalled();
});

it('does not refit after stopping during a drift probe', async () => {
	const refit = vi.fn();
	const probe = vi.fn(async (): Promise<string | null> => null);
	stop = watchDisplayChanges(refit, probe);
	await vi.advanceTimersByTimeAsync(0);
	let resolve!: (drift: string | null) => void;
	probe.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
	await vi.advanceTimersByTimeAsync(4000);
	stop();
	resolve('hidden');
	await vi.advanceTimersByTimeAsync(0);
	expect(refit).not.toHaveBeenCalled();
});
