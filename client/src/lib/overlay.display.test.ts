import { afterEach, expect, it, vi } from 'vitest';
// The cold import of overlay.ts (a large module) can exceed 5s under the parallel coverage run.
vi.setConfig({ testTimeout: 30_000 });
const fixture = vi.hoisted(() => ({
	monitors: [
		{
			name: 'DISPLAY1',
			position: { x: 0, y: 0 },
			size: { width: 100, height: 100 },
			scaleFactor: 1
		},
		{
			name: 'DISPLAY2',
			position: { x: 100, y: 0 },
			size: { width: 100, height: 100 },
			scaleFactor: 1
		}
	],
	invoke: vi.fn()
}));
vi.mock('@tauri-apps/api/window', async (original) => ({
	...(await original<typeof import('@tauri-apps/api/window')>()),
	availableMonitors: vi.fn(async () => fixture.monitors),
	primaryMonitor: vi.fn(async () => fixture.monitors[0])
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.invoke }));
vi.mock('./bridge/logging', () => ({ logClient: vi.fn() }));
let stop: (() => void) | undefined;
afterEach(() => {
	stop?.();
	vi.useRealTimers();
});
it('returns fresh IDs and dimensions after a topology change interrupts Studio monitor options', async () => {
	vi.useFakeTimers();
	let finish!: (value: unknown) => void;
	fixture.invoke
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		)
		.mockResolvedValue([{ gdi: 'DISPLAY2', friendly: 'New monitor', stable: 'new-id' }]);
	const { studioMonitorOptions, watchDisplayChanges } = await import('./overlay');
	const old = studioMonitorOptions();
	stop = watchDisplayChanges(vi.fn());
	await vi.advanceTimersByTimeAsync(0);
	fixture.monitors = [
		fixture.monitors[0],
		{ ...fixture.monitors[1], size: { width: 200, height: 100 } }
	];
	await vi.advanceTimersByTimeAsync(4000);
	expect(await studioMonitorOptions()).toContainEqual(
		expect.objectContaining({ key: 'new-id', w: 200 })
	);
	finish([{ gdi: 'DISPLAY2', friendly: 'Old monitor', stable: 'old-id' }]);
	expect(await old).toContainEqual(expect.objectContaining({ key: 'new-id', w: 200 }));
	expect(await studioMonitorOptions()).toContainEqual(
		expect.objectContaining({ key: 'new-id', w: 200 })
	);
	expect(fixture.invoke).toHaveBeenCalledTimes(2);
});
