import { expect, it, vi } from 'vitest';
import { createMcpStudioController } from './mcpStudioController';
import { emptyMonitorLayout } from '../core/layoutTree';
const setup = () => {
	const ports = {
		claim: vi.fn().mockResolvedValue(true),
		reply: vi.fn().mockResolvedValue(undefined)
	};
	const snapshot = { monitorKey: 'primary', monitor: emptyMonitorLayout() };
	const studio = {
		read: vi.fn(() => snapshot),
		apply: vi.fn(() => ({ applied: 1, addedIds: ['clock'], errors: [] })),
		verify: vi.fn().mockResolvedValue({
			ok: true,
			measured: true,
			checked: 1,
			issues: [],
			visualReviewRequired: true
		})
	};
	return { ports, studio, controller: createMcpStudioController(ports, studio) };
};
it('requires a read revision, consumes it once, and returns rendered verification', async () => {
	const s = setup();
	await s.controller.handle({ id: 'read', name: 'studio_read', args: {} });
	expect(s.ports.reply).toHaveBeenLastCalledWith('read', { ...s.studio.read(), revision: 'read' });
	await s.controller.handle({
		id: 'edit',
		name: 'studio_apply',
		args: { revision: 'read', ops: [{ op: 'addWidget', widgetType: 'clock' }] }
	});
	expect(s.studio.apply).toHaveBeenCalledOnce();
	await s.controller.handle({
		id: 'duplicate',
		name: 'studio_apply',
		args: { revision: 'read', ops: [] }
	});
	expect(s.studio.apply).toHaveBeenCalledOnce();
	expect(s.ports.reply).toHaveBeenLastCalledWith('duplicate', {
		error: expect.stringContaining('revision')
	});
	await s.controller.handle({ id: 'verify', name: 'studio_verify', args: {} });
	expect(s.studio.verify).toHaveBeenCalledWith(s.studio.read());
});
it('reports unknown, malformed, read-only, and failed tools without changing the layout', async () => {
	const s = setup();
	await s.controller.handle({ id: 'unknown', name: 'shell', args: {} });
	await s.controller.handle({ id: 'missing', name: 'studio_apply', args: null });
	await s.controller.handle({ id: 'read', name: 'studio_read', args: {} });
	await s.controller.handle({
		id: 'bad',
		name: 'studio_apply',
		args: { revision: 'read', ops: [{}] }
	});
	s.studio.read.mockReturnValue({ ...s.studio.read(), editable: false } as ReturnType<
		typeof s.studio.read
	>);
	await s.controller.handle({ id: 'readonly', name: 'studio_read', args: {} });
	await s.controller.handle({
		id: 'refuse',
		name: 'studio_apply',
		args: { revision: 'readonly', ops: [] }
	});
	expect(s.studio.apply).not.toHaveBeenCalled();
	expect(s.ports.reply).toHaveBeenLastCalledWith('refuse', {
		error: expect.stringContaining('read-only')
	});
	s.studio.verify.mockRejectedValue(new Error('Target changed'));
	await s.controller.handle({ id: 'verify', name: 'studio_verify', args: {} });
	expect(s.ports.reply).toHaveBeenLastCalledWith('verify', {
		error: expect.stringContaining('Target changed')
	});
});
it('does not run expired or disposed requests, including a claim already in flight', async () => {
	const s = setup();
	s.ports.claim.mockResolvedValueOnce(false);
	await s.controller.handle({ id: 'expired', name: 'studio_read', args: {} });
	expect(s.studio.read).not.toHaveBeenCalled();
	let finish!: (value: boolean) => void;
	s.ports.claim.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			})
	);
	const pending = s.controller.handle({ id: 'slow', name: 'studio_read', args: {} });
	await Promise.resolve();
	s.controller.dispose();
	finish(true);
	await pending;
	await s.controller.handle({ id: 'disposed', name: 'studio_read', args: {} });
	expect(s.studio.read).not.toHaveBeenCalled();
	expect(s.ports.reply).not.toHaveBeenCalled();
});
it('bounds old snapshots and keeps the queue usable after a failed reply', async () => {
	const s = setup();
	for (let i = 0; i < 17; i++)
		await s.controller.handle({ id: String(i), name: 'studio_read', args: {} });
	await s.controller.handle({ id: 'old', name: 'studio_apply', args: { revision: '0', ops: [] } });
	expect(s.studio.apply).not.toHaveBeenCalled();
	s.ports.reply.mockRejectedValueOnce(new Error('Disconnected'));
	await expect(s.controller.handle({ id: 'fail', name: 'studio_read', args: {} })).rejects.toThrow(
		'Disconnected'
	);
	await s.controller.handle({ id: 'next', name: 'studio_read', args: {} });
	expect(s.ports.reply).toHaveBeenLastCalledWith(
		'next',
		expect.objectContaining({ revision: 'next' })
	);
});
it('drops a verification reply after the controller is disposed', async () => {
	const s = setup();
	let finish!: (value: unknown) => void;
	s.studio.verify.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			})
	);
	const pending = s.controller.handle({ id: 'verify', name: 'studio_verify', args: {} });
	await Promise.resolve();
	await Promise.resolve();
	s.controller.dispose();
	finish({ ok: true });
	await pending;
	expect(s.ports.reply).not.toHaveBeenCalled();
});
