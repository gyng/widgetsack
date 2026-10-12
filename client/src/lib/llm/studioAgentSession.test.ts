import { describe, expect, it, vi } from 'vitest';
import {
	createStudioAgentSession,
	type AgentEvent,
	type AgentPorts,
	type AgentState
} from './studioAgentSession';
import { emptyMonitorLayout } from '../core/layoutTree';

function setup() {
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
	let snapshot = { monitorKey: 'primary', monitor: emptyMonitorLayout() };
	const apply = vi.fn().mockReturnValue({ applied: 1, addedIds: ['clock'], errors: [] });
	const updates: AgentState[] = [];
	const session = createStudioAgentSession(
		ports,
		{ read: () => snapshot, apply },
		(state) => updates.push(state),
		() => 'run'
	);
	return {
		session,
		ports,
		apply,
		updates,
		receive: (event: AgentEvent) => receive(event),
		finish: () => resolve(),
		switchMonitor: () => {
			snapshot = { ...snapshot, monitorKey: 'secondary' };
		}
	};
}
describe('studio agent session', () => {
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
