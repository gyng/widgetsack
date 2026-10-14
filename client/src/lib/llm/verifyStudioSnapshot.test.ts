import { expect, it, vi } from 'vitest';
import { verifyStudioSnapshot } from './verifyStudioSnapshot';
import { emptyMonitorLayout } from '../core/layoutTree';
import type { StudioSnapshot } from './studioAgentSession';
import type { StudioVerification } from '../core/studioVerification';

const report: StudioVerification = {
	ok: true,
	measured: true,
	checked: 1,
	issues: [],
	visualReviewRequired: true
};

it.each(['monitor', 'monitorKey', 'editorTarget', 'library', 'workArea'])(
	'rejects a changed %s after rendering settles',
	async (key) => {
		const expected: StudioSnapshot = {
			monitorKey: 'primary',
			editorTarget: 'monitor:primary',
			monitor: emptyMonitorLayout(),
			library: { defs: [] },
			workArea: { x: 0, y: 0, w: 800, h: 600 }
		};
		let current = expected;
		let ready!: () => void;
		const measure = vi.fn(() => report);
		const pending = verifyStudioSnapshot(expected, {
			read: () => current,
			measure,
			ready: () =>
				new Promise<void>((resolve) => {
					ready = resolve;
				})
		});
		const replacements: Record<string, unknown> = {
			monitor: emptyMonitorLayout(),
			monitorKey: 'secondary',
			editorTarget: 'monitor:secondary',
			library: { defs: [] },
			workArea: { x: 0, y: 0, w: 800, h: 700 }
		};
		current = { ...expected, [key]: replacements[key] };
		ready();
		await expect(pending).rejects.toThrow('changed');
		expect(measure).not.toHaveBeenCalled();
	}
);

it('uses the current measurement callback after rendering settles', async () => {
	const snapshot: StudioSnapshot = { monitorKey: 'primary', monitor: emptyMonitorLayout() };
	let ready!: () => void;
	const ports = {
		read: () => snapshot,
		measure: vi.fn(() => report),
		ready: () =>
			new Promise<void>((resolve) => {
				ready = resolve;
			})
	};
	const old = ports.measure;
	const pending = verifyStudioSnapshot(snapshot, ports);
	ports.measure = vi.fn(() => report);
	ready();
	await expect(pending).resolves.toBe(report);
	expect(old).not.toHaveBeenCalled();
	expect(ports.measure).toHaveBeenCalledWith(snapshot);
});

it('stops without reading or measuring when cancelled while rendering settles', async () => {
	const controller = new AbortController();
	const ports = {
		read: vi.fn(() => ({ monitorKey: 'primary', monitor: emptyMonitorLayout() })),
		measure: vi.fn(() => report),
		ready: async () => controller.abort()
	};
	await expect(verifyStudioSnapshot(ports.read(), ports, controller.signal)).rejects.toThrow(
		'cancelled'
	);
	expect(ports.read).toHaveBeenCalledOnce();
	expect(ports.measure).not.toHaveBeenCalled();
});
