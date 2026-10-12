import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelemetryHub } from '../core/telemetry';
import { COMMANDS } from '../bridge/contract';
const mocks = vi.hoisted(() => ({
	invoke: vi.fn(async () => ['cpu.core.0.freq', 'disk.c.free']),
	listen: vi.fn(async () => vi.fn()),
	studio: true
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../overlay', () => ({ isStudioWindow: () => mocks.studio }));
import { startTelemetrySource, systemSource } from './source';
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	mocks.invoke.mockClear();
	mocks.studio = true;
});
describe('system sensor discovery and demand', () => {
	it('discovers hardware IDs without wildcard demand, releases demand on stop', async () => {
		vi.useFakeTimers();
		const hub = createTelemetryHub();
		const off = hub.sensor('cpu.freq').subscribe(() => {});
		const stop = await startTelemetrySource(hub);
		expect(mocks.invoke).toHaveBeenCalledWith(COMMANDS.setActiveSensors, { ids: ['cpu.freq'] });
		expect(systemSource.catalog?.()).toContain('disk.c.free');
		expect(systemSource.catalog?.()).toContain('recyclebin.items');
		off();
		await vi.advanceTimersByTimeAsync(250);
		expect(mocks.invoke).toHaveBeenLastCalledWith(COMMANDS.setActiveSensors, { ids: [] });
		stop();
		const calls = mocks.invoke.mock.calls.length;
		hub.sensor('gpu.util').subscribe(() => {});
		await vi.advanceTimersByTimeAsync(250);
		expect(mocks.invoke.mock.calls.length).toBe(calls);
	});
	it('pauses hidden Studio demand and restores it without pausing overlays', async () => {
		vi.useFakeTimers();
		const hub = createTelemetryHub();
		hub.sensor('recyclebin.items').subscribe(() => {});
		const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
		const stop = await startTelemetrySource(hub);
		visible.mockReturnValue('hidden');
		document.dispatchEvent(new Event('visibilitychange'));
		expect(mocks.invoke).toHaveBeenLastCalledWith(COMMANDS.setActiveSensors, { ids: [] });
		visible.mockReturnValue('visible');
		document.dispatchEvent(new Event('visibilitychange'));
		expect(mocks.invoke).toHaveBeenLastCalledWith(COMMANDS.setActiveSensors, {
			ids: ['recyclebin.items']
		});
		stop();
		mocks.studio = false;
		visible.mockReturnValue('hidden');
		const stopOverlay = await startTelemetrySource(hub);
		expect(mocks.invoke).toHaveBeenLastCalledWith(COMMANDS.setActiveSensors, {
			ids: ['recyclebin.items']
		});
		stopOverlay();
	});
});
