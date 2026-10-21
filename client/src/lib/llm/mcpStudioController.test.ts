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

it('routes integration tools without layout revisions and cancels their pending response', async () => {
	const ports = {
		claim: vi.fn().mockResolvedValue(true),
		reply: vi.fn().mockResolvedValue(undefined)
	};
	let finish!: (value: unknown) => void;
	const integrationTool = vi.fn(
		(_name: string, _args: unknown, _signal?: AbortSignal) =>
			new Promise((resolve) => {
				finish = resolve;
			})
	);
	const studio = {
		read: () => ({ monitorKey: 'primary', monitor: emptyMonitorLayout() }),
		apply: vi.fn(),
		verify: vi.fn(),
		integrationTool
	};
	const controller = createMcpStudioController(ports, studio);
	const pending = controller.handle({
		id: 'configure',
		name: 'studio_configure_integration',
		args: { integration: 'home-assistant', settings: {} }
	});
	await vi.waitFor(() => expect(integrationTool).toHaveBeenCalledOnce());
	await controller.handle({ id: 'configure', cancelled: true });
	expect(integrationTool.mock.calls[0][2]?.aborted).toBe(true);
	finish({ persisted: true });
	await pending;
	expect(ports.reply).not.toHaveBeenCalled();
	controller.dispose();
});

it('uses the shared integration service when no override is supplied', async () => {
	const s = setup();
	await s.controller.handle({
		id: 'invalid-settings',
		name: 'studio_configure_integration',
		args: { integration: 'unknown' }
	});
	expect(s.ports.reply).toHaveBeenCalledWith('invalid-settings', {
		error: expect.stringContaining('Unknown integration')
	});
});

it('releases a cancelled verification so a later tool can run before rendering finishes', async () => {
	const s = setup();
	let finish!: (value: unknown) => void;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	s.studio.verify.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
				started();
			})
	);
	const verifying = s.controller.handle({ id: 'verify', name: 'studio_verify', args: {} });
	await ready;
	expect(s.studio.verify).toHaveBeenCalledOnce();
	await s.controller.handle({ id: 'verify', name: 'studio_verify', args: {} });
	const cancelling = s.controller.handle({ id: 'verify', cancelled: true });
	const reading = s.controller.handle({ id: 'next', name: 'studio_read', args: {} });
	await reading;
	finish({ ok: true });
	await Promise.all([verifying, reading, cancelling]);
	// The implementation gets the request's signal, so cancelling stops its render wait too.
	const signal = s.studio.verify.mock.calls[0][1] as AbortSignal;
	expect(signal.aborted).toBe(true);
	expect(s.ports.reply).not.toHaveBeenCalledWith('verify', expect.anything());
	expect(s.ports.reply).toHaveBeenCalledWith('next', expect.objectContaining({ revision: 'next' }));
});
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
	expect(s.studio.verify).toHaveBeenCalledWith(s.studio.read(), expect.any(AbortSignal));
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
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	s.studio.verify.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
				started();
			})
	);
	const pending = s.controller.handle({ id: 'verify', name: 'studio_verify', args: {} });
	await ready;
	s.controller.dispose();
	finish({ ok: true });
	await pending;
	expect(s.ports.reply).not.toHaveBeenCalled();
});
it('skips a request cancelled while it waits behind another tool', async () => {
	const s = setup();
	let finish!: (value: unknown) => void;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	s.studio.verify.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
				started();
			})
	);
	const verifying = s.controller.handle({ id: 'verify', name: 'studio_verify', args: {} });
	await ready;
	const queued = s.controller.handle({ id: 'queued', name: 'studio_read', args: {} });
	await s.controller.handle({ id: 'queued', cancelled: true });
	finish({ ok: true });
	await Promise.all([verifying, queued]);
	expect(s.ports.claim).not.toHaveBeenCalledWith('queued');
	expect(s.ports.reply).not.toHaveBeenCalledWith('queued', expect.anything());
	expect(s.ports.reply).toHaveBeenCalledWith('verify', { ok: true });
});
