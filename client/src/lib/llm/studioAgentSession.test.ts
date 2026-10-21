import { describe, expect, it, vi } from 'vitest';
import {
	createStudioAgentSession,
	type AgentEvent,
	type AgentPorts,
	type AgentState,
	type StudioSnapshot
} from './studioAgentSession';
import { emptyMonitorLayout } from '../core/layoutTree';

function setup(
	withVerification = false,
	integrationTool?: (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>
) {
	let receive: (event: AgentEvent) => void = () => {};
	let resolve: () => void = () => {};
	const ports: AgentPorts = {
		run: vi.fn((_request, next) => {
			receive = next;
			return new Promise<void>((done) => {
				resolve = done;
			});
		}),
		reply: vi.fn().mockResolvedValue(undefined),
		cancel: vi.fn().mockResolvedValue(undefined)
	};
	let snapshot: StudioSnapshot = { monitorKey: 'primary', monitor: emptyMonitorLayout() };
	const apply = vi.fn().mockReturnValue({ applied: 1, addedIds: ['clock'], errors: [] });
	const verify = vi.fn().mockResolvedValue({
		ok: true,
		measured: true,
		checked: 1,
		issues: [],
		visualReviewRequired: true
	});
	const updates: AgentState[] = [];
	const session = createStudioAgentSession(
		ports,
		{ read: () => snapshot, apply, ...(withVerification ? { verify } : {}), integrationTool },
		(state) => updates.push(state),
		() => 'run'
	);
	return {
		session,
		ports,
		apply,
		verify,
		readonly: () => {
			snapshot = { ...snapshot, editable: false };
		},
		target: (editorTarget: string) => {
			snapshot = { ...snapshot, editorTarget };
		},
		updates,
		receive: (event: AgentEvent) => receive(event),
		finish: () => resolve(),
		switchMonitor: () => {
			snapshot = { ...snapshot, monitorKey: 'secondary' };
		}
	};
}

it('routes configuration tools and never replies after a stopped run', async () => {
	let finish!: (value: unknown) => void;
	const tool = vi.fn(
		(_name: string, _args: unknown, _signal?: AbortSignal) =>
			new Promise((resolve) => {
				finish = resolve;
			})
	);
	const s = setup(false, tool);
	const running = s.session.send('Configure Home Assistant', 'codex', '');
	s.receive({
		type: 'tool',
		id: 'config',
		name: 'studio_configure_integration',
		args: { integration: 'home-assistant', settings: {} }
	});
	expect(tool).toHaveBeenCalledOnce();
	s.session.stop();
	expect(tool.mock.calls[0][2]?.aborted).toBe(true);
	finish({ persisted: true });
	await Promise.resolve();
	expect(s.ports.reply).not.toHaveBeenCalled();
	s.finish();
	await running;
});
it('returns configuration outcomes and safe validation failures to the installed agent', async () => {
	const tool = vi.fn().mockResolvedValue({ persisted: true });
	const s = setup(false, tool);
	const running = s.session.send('Set up integrations', 'codex', '');
	s.receive({ type: 'tool', id: 'config', name: 'studio_configure_integration', args: {} });
	await vi.waitFor(() =>
		expect(s.ports.reply).toHaveBeenCalledWith('run', 'config', { persisted: true })
	);
	tool.mockRejectedValueOnce(new Error('private backend payload'));
	s.receive({ type: 'tool', id: 'failed', name: 'studio_test_integration', args: {} });
	await vi.waitFor(() =>
		expect(s.ports.reply).toHaveBeenCalledWith('run', 'failed', {
			error: 'Integration request failed.'
		})
	);
	s.finish();
	await running;
	const defaults = setup();
	const next = defaults.session.send('Setup', 'codex', '');
	defaults.receive({ type: 'tool', id: 'unknown', name: 'studio_configure_integration', args: {} });
	await vi.waitFor(() =>
		expect(defaults.ports.reply).toHaveBeenCalledWith('run', 'unknown', {
			error: 'Integration request failed.'
		})
	);
	defaults.finish();
	await next;
});

it('handles a disconnected integration reply and ignores a rejection after cancellation', async () => {
	const tool = vi.fn().mockRejectedValue(new Error('private backend detail'));
	const s = setup(false, tool);
	vi.mocked(s.ports.reply).mockRejectedValue(new Error('transport closed'));
	const running = s.session.send('Configure', 'codex', '');
	s.receive({ type: 'tool', id: 'failed', name: 'studio_test_integration', args: {} });
	await vi.waitFor(() => expect(s.updates.at(-1)?.error).toBe('Integration request failed.'));
	let fail!: (error: Error) => void;
	tool.mockImplementationOnce(
		() =>
			new Promise((_, reject) => {
				fail = reject;
			})
	);
	s.receive({ type: 'tool', id: 'cancelled', name: 'studio_test_integration', args: {} });
	s.session.stop();
	fail(new Error('cancelled private detail'));
	await Promise.resolve();
	s.finish();
	await running;
	expect(s.ports.reply).toHaveBeenCalledTimes(1);
});
describe('studio agent session', () => {
	it.each(['stop', 'reset'] as const)(
		'discards prompts waiting for cancellation when %s is requested',
		async (action) => {
			const s = setup();
			let cancelled!: () => void;
			vi.mocked(s.ports.cancel).mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						cancelled = resolve;
					})
			);
			const first = s.session.send('first', 'pi', '');
			s.session.stop();
			const waiting = s.session.send('queued', 'pi', '');
			s.session[action]();
			cancelled();
			await Promise.resolve();
			await Promise.resolve();
			expect(s.ports.run).toHaveBeenCalledTimes(1);
			s.finish();
			await Promise.all([first, waiting]);
			if (action === 'reset') expect(s.updates.at(-1)?.messages).toEqual([]);
			s.session.dispose();
		}
	);

	it('waits for cancellation before accepting a new request and ignores failures from the stopped run', async () => {
		const s = setup();
		let cancelDone = () => {};
		vi.mocked(s.ports.cancel).mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					cancelDone = resolve;
				})
		);
		let failRun: (error: Error) => void = () => {};
		let firstReceive: (event: AgentEvent) => void = () => {};
		vi.mocked(s.ports.run).mockImplementationOnce((_request, callback) => {
			firstReceive = callback;
			return new Promise<void>((_resolve, reject) => {
				failRun = reject;
			});
		});
		let failReply: (error: Error) => void = () => {};
		vi.mocked(s.ports.reply).mockImplementationOnce(
			() =>
				new Promise<void>((_resolve, reject) => {
					failReply = reject;
				})
		);
		const first = s.session.send('first', 'pi', '');
		firstReceive({ type: 'tool', id: 'read', name: 'studio_read', args: {} });
		s.session.stop();
		const second = s.session.send('second', 'pi', '');
		const competing = s.session.send('competing', 'pi', '');
		expect(s.ports.run).toHaveBeenCalledOnce();
		failReply(new Error('old reply'));
		failRun(new Error('Stopped'));
		cancelDone();
		await first;
		await competing;
		await Promise.resolve();
		expect(s.ports.run).toHaveBeenCalledTimes(2);
		expect(s.updates.at(-1)?.error).toBe('');
		s.finish();
		await second;
	});
	it('does not restart after disposal while cancellation is pending, including a failed cancel', async () => {
		const s = setup();
		vi.mocked(s.ports.cancel).mockRejectedValue(new Error('already closed'));
		const first = s.session.send('first', 'pi', '');
		s.session.stop();
		const second = s.session.send('second', 'pi', '');
		s.session.dispose();
		s.finish();
		await first;
		await second;
		expect(s.ports.run).toHaveBeenCalledOnce();
	});
	it('reads before editing, validates actions, and streams the reply through one owned run', async () => {
		const s = setup();
		const pending = s.session.send(' Add a clock ', 'pi', '');
		await s.session.send('duplicate', 'pi', '');
		expect(s.ports.run).toHaveBeenCalledOnce();
		s.receive({ type: 'tool', id: 'read', name: 'studio_read', args: {} });
		s.receive({
			type: 'tool',
			id: 'apply',
			name: 'studio_apply',
			args: { ops: [{ op: 'addWidget', widgetType: 'clock' }] }
		});
		s.receive({ type: 'text', text: 'Done.' });
		s.finish();
		await pending;
		expect(s.apply).toHaveBeenCalledOnce();
		expect(s.updates.at(-1)).toMatchObject({
			busy: false,
			error: '',
			actions: ['1 action(s) applied'],
			messages: [
				{ role: 'user', text: 'Add a clock' },
				{ role: 'assistant', text: 'Done.' }
			]
		});
	});
	it('blocks edits without a read, unknown tools, invalid actions, and a changed monitor', async () => {
		const s = setup();
		const pending = s.session.send('edit', 'pi', '');
		s.receive({ type: 'tool', id: 'a', name: 'studio_apply', args: { ops: [] } });
		s.receive({ type: 'tool', id: 'x', name: 'shell', args: {} });
		s.receive({ type: 'tool', id: 'r', name: 'studio_read', args: {} });
		s.receive({ type: 'tool', id: 'b', name: 'studio_apply', args: null });
		s.switchMonitor();
		s.receive({ type: 'tool', id: 'c', name: 'studio_read', args: {} });
		s.finish();
		await pending;
		expect(s.apply).not.toHaveBeenCalled();
		expect(s.updates.at(-1)?.error).toContain('monitor changed');
	});
	it('stop and dispose reject late callbacks and keep a reset conversation empty', async () => {
		const s = setup();
		const pending = s.session.send('edit', 'codex', '');
		s.session.reset();
		s.receive({ type: 'tool', id: 'late', name: 'studio_apply', args: { ops: [{ op: 'clear' }] } });
		s.receive({ type: 'text', text: 'late' });
		s.finish();
		await pending;
		expect(s.ports.cancel).toHaveBeenCalledWith('run');
		expect(s.apply).not.toHaveBeenCalled();
		expect(s.updates.at(-1)?.messages).toEqual([]);
		s.session.dispose();
		await s.session.send('ignored', 'pi', '');
		expect(s.ports.run).toHaveBeenCalledOnce();
	});
	it('reports model and tool errors without dropping successful action feedback', async () => {
		const s = setup();
		const pending = s.session.send('edit', 'claude', '');
		s.apply.mockReturnValue({ applied: 0, addedIds: [], errors: ['layout changed'] });
		s.receive({ type: 'tool', id: 'r', name: 'studio_read', args: {} });
		s.receive({ type: 'tool', id: 'a', name: 'studio_apply', args: { ops: [] } });
		s.receive({ type: 'error', text: 'provider failed' });
		s.finish();
		await pending;
		expect(s.updates.at(-1)).toMatchObject({
			error: 'provider failed',
			actions: ['0 action(s) applied · layout changed']
		});
	});
	it('handles failed commands and reply delivery, ignores empty prompts, and rejects failures after stop', async () => {
		const s = setup();
		await s.session.send(' ', 'pi', '');
		expect(s.ports.run).not.toHaveBeenCalled();
		vi.mocked(s.ports.run).mockRejectedValueOnce(new Error('missing runtime'));
		await s.session.send('edit', 'pi', '');
		expect(s.updates.at(-1)?.error).toContain('missing runtime');
		vi.mocked(s.ports.reply).mockRejectedValue(new Error('disconnected'));
		const pending = s.session.send('edit', 'pi', '');
		s.receive({ type: 'tool', id: 'r', name: 'studio_read', args: {} });
		await Promise.resolve();
		expect(s.updates.at(-1)?.error).toContain('disconnected');
		s.session.stop();
		s.finish();
		await pending;
	});
});

it('returns rendered verification and ignores late verification after stopping', async () => {
	const s = setup(true);
	const pending = s.session.send('Verify', 'pi', '');
	s.receive({ type: 'tool', id: 'verify', name: 'studio_verify', args: {} });
	await Promise.resolve();
	await Promise.resolve();
	expect(s.ports.reply).toHaveBeenCalledWith(
		'run',
		'verify',
		expect.objectContaining({ checked: 1 })
	);
	expect(s.updates.at(-1)?.actions[0]).toContain('visual review required');
	let finish!: (value: unknown) => void;
	s.verify.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			})
	);
	s.receive({ type: 'tool', id: 'late', name: 'studio_verify', args: {} });
	s.session.stop();
	finish({ checked: 2, issues: [] });
	await Promise.resolve();
	expect(s.ports.reply).not.toHaveBeenCalledWith('run', 'late', expect.anything());
	s.finish();
	await pending;
});
it('rejects verification failures, unavailable verification, read-only targets and changed editor targets', async () => {
	const s = setup();
	const pending = s.session.send('Edit', 'pi', '');
	s.receive({ type: 'tool', id: 'verify', name: 'studio_verify', args: {} });
	expect(s.updates.at(-1)?.error).toContain('unavailable');
	s.receive({ type: 'tool', id: 'read', name: 'studio_read', args: {} });
	s.readonly();
	s.receive({ type: 'tool', id: 'edit', name: 'studio_apply', args: { ops: [] } });
	expect(s.apply).not.toHaveBeenCalled();
	expect(s.updates.at(-1)?.error).toContain('read-only');
	s.target('preview:clock');
	s.receive({ type: 'tool', id: 'read2', name: 'studio_read', args: {} });
	expect(s.updates.at(-1)?.error).toContain('editor target changed');
	s.finish();
	await pending;
	const failed = setup(true);
	const run = failed.session.send('Verify', 'pi', '');
	failed.verify.mockRejectedValue(new Error('Geometry changed'));
	failed.receive({ type: 'tool', id: 'verify', name: 'studio_verify', args: {} });
	await Promise.resolve();
	await Promise.resolve();
	expect(failed.updates.at(-1)?.error).toContain('Geometry changed');
	failed.finish();
	await run;
});

it('ignores a verification failure after stop and handles a failed error reply', async () => {
	const s = setup(true);
	const pending = s.session.send('Verify', 'pi', '');
	let fail!: (error: Error) => void;
	s.verify.mockImplementationOnce(
		() =>
			new Promise((_resolve, reject) => {
				fail = reject;
			})
	);
	s.receive({ type: 'tool', id: 'late', name: 'studio_verify', args: {} });
	s.session.stop();
	fail(new Error('Old verification'));
	await Promise.resolve();
	await Promise.resolve();
	expect(s.ports.reply).not.toHaveBeenCalled();
	s.finish();
	await pending;
	const failed = setup(true);
	const run = failed.session.send('Verify', 'pi', '');
	failed.verify.mockRejectedValue(new Error('Could not measure'));
	vi.mocked(failed.ports.reply).mockRejectedValue(new Error('Closed'));
	failed.receive({ type: 'tool', id: 'verify', name: 'studio_verify', args: {} });
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	expect(failed.updates.at(-1)?.error).toContain('Could not measure');
	failed.finish();
	await run;
});
