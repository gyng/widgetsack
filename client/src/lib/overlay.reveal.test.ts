import { beforeEach, expect, it, vi } from 'vitest';
// The cold import of overlay.ts (a large module) can exceed 5s under the parallel coverage run.
vi.setConfig({ testTimeout: 30_000 });
const fixture = vi.hoisted(() => ({
	win: {
		label: 'overlay-DISPLAY2',
		setPosition: vi.fn(async () => {}),
		setSize: vi.fn(async () => {}),
		outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
		outerSize: vi.fn(async () => ({ width: 100, height: 100 })),
		isMinimized: vi.fn(async () => false),
		isVisible: vi.fn(async () => false),
		setDecorations: vi.fn(async () => {}),
		setShadow: vi.fn(async () => {}),
		setIgnoreCursorEvents: vi.fn(async () => {}),
		show: vi.fn(async () => {}),
		setAlwaysOnTop: vi.fn(async () => {}),
		setAlwaysOnBottom: vi.fn(async () => {})
	}
}));
vi.mock('@tauri-apps/api/window', async (original) => ({
	...(await original<typeof import('@tauri-apps/api/window')>()),
	availableMonitors: vi.fn(async () => [
		{
			name: 'DISPLAY2',
			position: { x: 0, y: 0 },
			size: { width: 100, height: 100 },
			scaleFactor: 1
		}
	]),
	getCurrentWindow: () => fixture.win
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(async () => {}) }));
vi.mock('./bridge/logging', () => ({ logClient: vi.fn() }));
beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	localStorage.clear();
});
it.each(['setIgnoreCursorEvents', 'show'] as const)(
	'retries passive reveal after %s fails',
	async (operation) => {
		const { fillOwnMonitor } = await import('./overlay');
		fixture.win[operation].mockRejectedValueOnce(new Error('temporary window failure'));
		await fillOwnMonitor('DISPLAY2');
		await fillOwnMonitor('DISPLAY2');
		expect(fixture.win.setIgnoreCursorEvents).toHaveBeenCalledTimes(2);
		expect(fixture.win.show).toHaveBeenCalled();
		expect(fixture.win.setAlwaysOnBottom).toHaveBeenCalledWith(true);
	}
);
