import { beforeEach, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
const fixture = vi.hoisted(() => ({
	invoke: vi.fn(async (_command: string, _args?: unknown) => 'applied'),
	win: {
		label: 'main',
		setAlwaysOnTop: vi.fn(async (_enabled: boolean) => {}),
		setAlwaysOnBottom: vi.fn(async (_enabled: boolean) => {}),
		setDecorations: vi.fn(async (_enabled: boolean) => {}),
		setShadow: vi.fn(async (_enabled: boolean) => {}),
		setSkipTaskbar: vi.fn(async (_enabled: boolean) => {}),
		setIgnoreCursorEvents: vi.fn(async (_enabled: boolean) => {})
	}
}));
vi.mock('@tauri-apps/api/window', async (original) => ({
	...(await original<typeof import('@tauri-apps/api/window')>()),
	getCurrentWindow: () => fixture.win
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(async () => {}) }));
beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
});

it('a delayed desktop enable cannot overwrite a newer layer selection', async () => {
	let finish!: (value: string) => void;
	let desktop = false;
	fixture.invoke.mockImplementation(async (command, args) => {
		if (command === 'set_overlay_desktop') {
			const enabled = (args as { enabled: boolean }).enabled;
			if (enabled)
				await new Promise<string>((resolve) => {
					finish = resolve;
				});
			desktop = enabled;
		}
		return 'applied';
	});
	const { applyOverlayLayer } = await import('./overlay');
	const older = applyOverlayLayer('desktop');
	await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
	const newer = applyOverlayLayer('top');
	finish('enabled');
	await Promise.all([older, newer]);
	expect(desktop).toBe(false);
	expect(fixture.win.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
	expect(fixture.win.setAlwaysOnBottom).toHaveBeenLastCalledWith(false);
});

it('windowed debug unregisters the desktop layer and restores normal window behavior', async () => {
	fixture.invoke.mockResolvedValue('applied');
	const { applyOverlayLayer, applyOverlayPresentation } = await import('./overlay');
	const { overlayPresentation } = await import('./widgets/canvas/overlayPresentation');
	await applyOverlayLayer('desktop');
	await applyOverlayPresentation(
		overlayPresentation({ windowed: true, layer: 'desktop', editMode: false }),
		'desktop'
	);
	expect(fixture.invoke).toHaveBeenLastCalledWith('set_overlay_desktop', { enabled: false });
	expect(fixture.win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
	expect(fixture.win.setAlwaysOnBottom).toHaveBeenLastCalledWith(false);
	expect(fixture.win.setIgnoreCursorEvents).toHaveBeenLastCalledWith(false);
});
