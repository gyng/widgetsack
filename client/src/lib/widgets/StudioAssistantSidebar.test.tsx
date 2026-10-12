import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StudioAssistantSidebar from './StudioAssistantSidebar';
import { studioAgentPorts, studioAgentStatus } from './plugins/studio-agent-commands';
import type { AgentEvent } from '../llm/studioAgentSession';
import { emptyMonitorLayout } from '../core/layoutTree';
vi.mock('./plugins/studio-agent-commands', () => ({
	studioAgentStatus: vi.fn(),
	studioAgentPorts: { run: vi.fn(), reply: vi.fn(), cancel: vi.fn() }
}));
const ready = {
	defaultBackend: 'pi',
	backends: [
		{ id: 'pi', label: 'Pi (installed)', available: true },
		{ id: 'codex', label: 'Codex', available: true },
		{ id: 'claude', label: 'Claude', available: false }
	]
};
const props = () => ({
	read: () => ({ monitorKey: 'primary', monitor: emptyMonitorLayout() }),
	apply: vi.fn().mockReturnValue({ applied: 1, addedIds: [], errors: [] }),
	onClose: vi.fn()
});
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(studioAgentStatus).mockResolvedValue(ready);
	vi.mocked(studioAgentPorts.run).mockResolvedValue(undefined);
	vi.mocked(studioAgentPorts.reply).mockResolvedValue(undefined);
	vi.mocked(studioAgentPorts.cancel).mockResolvedValue(undefined);
});
afterEach(cleanup);
describe('Studio assistant sidebar', () => {
	it('keeps a selected installed agent on refresh and clears its model when falling back', async () => {
		render(<StudioAssistantSidebar {...props()} />);
		await waitFor(() => expect(screen.getByLabelText('Agent backend')).toHaveValue('pi'));
		fireEvent.change(screen.getByLabelText('Agent backend'), { target: { value: 'codex' } });
		fireEvent.change(screen.getByLabelText('Agent model'), { target: { value: 'custom-model' } });
		fireEvent.click(screen.getByRole('button', { name: 'Refresh agents' }));
		await waitFor(() => expect(screen.getByLabelText('Agent model')).toHaveValue('custom-model'));
		vi.mocked(studioAgentStatus).mockResolvedValue({
			...ready,
			backends: ready.backends.map((agent) => ({ ...agent, available: agent.id === 'pi' }))
		});
		fireEvent.click(screen.getByRole('button', { name: 'Refresh agents' }));
		await waitFor(() => expect(screen.getByLabelText('Agent backend')).toHaveValue('pi'));
		await waitFor(() => expect(screen.getByLabelText('Agent model')).toHaveValue(''));
	});
	it('explains missing agents and blocks sending from both keyboard and form', async () => {
		vi.mocked(studioAgentStatus).mockResolvedValue({
			...ready,
			defaultBackend: '',
			backends: ready.backends.map((agent) => ({ ...agent, available: false }))
		});
		render(<StudioAssistantSidebar {...props()} />);
		expect(await screen.findByText(/No installed agent found/)).toBeVisible();
		const input = screen.getByLabelText('Message to studio assistant');
		fireEvent.change(input, { target: { value: 'Hello' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		fireEvent.submit(input.closest('form')!);
		expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
		expect(studioAgentPorts.run).not.toHaveBeenCalled();
		expect(screen.queryByText(/bundled SDK/)).toBeNull();
	});
	it('selects Codex when it is the detected default and ignores a status error after closing', async () => {
		vi.mocked(studioAgentStatus).mockResolvedValueOnce({
			...ready,
			defaultBackend: 'codex'
		});
		const { unmount } = render(<StudioAssistantSidebar {...props()} />);
		await waitFor(() => expect(screen.getByLabelText('Agent backend')).toHaveValue('codex'));
		await waitFor(() => expect(screen.getByLabelText('Agent model')).toHaveValue(''));
		let fail: (reason: Error) => void = () => {};
		vi.mocked(studioAgentStatus).mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					fail = reject;
				})
		);
		fireEvent.click(screen.getByRole('button', { name: 'Refresh agents' }));
		unmount();
		await act(async () => {
			fail(new Error('closed'));
			await Promise.resolve();
		});
	});
	it('prefers installed Pi and submits from the keyboard without treating Shift+Enter as send', async () => {
		const p = props();
		render(<StudioAssistantSidebar {...p} />);
		await waitFor(() => expect(screen.getByLabelText('Agent backend')).toHaveValue('pi'));
		expect(screen.getByLabelText('Agent backend')).toHaveValue('pi');
		fireEvent.click(screen.getByRole('button', { name: 'Add a clock' }));
		expect(screen.getByLabelText('Message to studio assistant')).toHaveValue('Add a clock');
		expect(screen.getByLabelText('Message to studio assistant')).toHaveFocus();
		fireEvent.change(screen.getByLabelText('Message to studio assistant'), {
			target: { value: '' }
		});
		fireEvent.change(screen.getByLabelText('Agent model'), { target: { value: '' } });
		const input = screen.getByLabelText('Message to studio assistant');
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(studioAgentPorts.run).not.toHaveBeenCalled();
		fireEvent.change(input, { target: { value: 'Add a clock' } });
		fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
		expect(studioAgentPorts.run).not.toHaveBeenCalled();
		fireEvent.keyDown(input, { key: 'Enter' });
		await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeVisible());
		expect(studioAgentPorts.run).toHaveBeenCalledWith(
			expect.objectContaining({ backend: 'pi', model: '' }),
			expect.any(Function)
		);
		fireEvent.click(screen.getByRole('button', { name: 'Close assistant' }));
		expect(p.onClose).toHaveBeenCalledOnce();
	});
	it('streams the reply, applies tools, stops work, and cancels on disposal', async () => {
		let receive: (event: AgentEvent) => void = () => {};
		let finish = () => {};
		vi.mocked(studioAgentPorts.run).mockImplementation((_request, callback) => {
			receive = callback;
			return new Promise<void>((resolve) => {
				finish = resolve;
			});
		});
		const p = props();
		const { unmount } = render(<StudioAssistantSidebar {...p} />);
		await waitFor(() => expect(screen.getByLabelText('Agent backend')).toHaveValue('pi'));
		fireEvent.change(screen.getByLabelText('Message to studio assistant'), {
			target: { value: 'Add a clock' }
		});
		fireEvent.submit(screen.getByLabelText('Message to studio assistant').closest('form')!);
		act(() => {
			receive({ type: 'tool', id: 'r', name: 'studio_read', args: {} });
			receive({
				type: 'tool',
				id: 'a',
				name: 'studio_apply',
				args: { ops: [{ op: 'addWidget', widgetType: 'clock' }] }
			});
			receive({ type: 'text', text: 'Done' });
		});
		expect(screen.getByText('Done')).toBeVisible();
		expect(screen.getByText('1 action(s) applied')).toBeVisible();
		fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
		await act(async () => {
			finish();
			await Promise.resolve();
		});
		fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
		expect(screen.queryByText('Done')).toBeNull();
		fireEvent.change(screen.getByLabelText('Message to studio assistant'), {
			target: { value: 'Again' }
		});
		fireEvent.click(screen.getByRole('button', { name: 'Send' }));
		await waitFor(() => expect(studioAgentPorts.run).toHaveBeenCalledTimes(2));
		unmount();
		expect(studioAgentPorts.cancel).toHaveBeenCalledTimes(2);
		await act(async () => {
			finish();
			await Promise.resolve();
		});
	});
	it('selects an installed agent and reports errors and missing setup', async () => {
		vi.mocked(studioAgentPorts.run).mockRejectedValue(new Error('Login required'));
		render(<StudioAssistantSidebar {...props()} />);
		await waitFor(() => expect(screen.getByLabelText('Agent backend')).toHaveValue('pi'));
		fireEvent.change(screen.getByLabelText('Agent backend'), { target: { value: 'codex' } });
		fireEvent.change(screen.getByLabelText('Agent model'), { target: { value: 'custom-model' } });
		fireEvent.change(screen.getByLabelText('Message to studio assistant'), {
			target: { value: 'Hello' }
		});
		fireEvent.click(screen.getByRole('button', { name: 'Send' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Login required');
	});
	it('ignores old status requests after refresh or unmount', async () => {
		let old: (value: typeof ready) => void = () => {};
		vi.mocked(studioAgentStatus).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					old = resolve;
				})
		);
		const { unmount } = render(<StudioAssistantSidebar {...props()} />);
		expect(screen.getByText('Checking agents…')).toBeVisible();
		fireEvent.click(screen.getByRole('button', { name: 'Refresh agents' }));
		await waitFor(() => expect(screen.getByLabelText('Agent backend')).toHaveValue('pi'));
		await act(async () => {
			old(ready);
			await Promise.resolve();
		});
		expect(screen.getByLabelText('Agent backend')).toHaveValue('pi');
		vi.mocked(studioAgentStatus).mockRejectedValue(new Error('Runtime missing'));
		fireEvent.click(screen.getByRole('button', { name: 'Refresh agents' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Runtime missing');
		unmount();
	});
});

it('filters installed model suggestions, accepts a custom ID, and resets it when the backend changes', async () => {
	vi.mocked(studioAgentStatus).mockResolvedValue({
		...ready,
		models: { pi: ['openai/sample-fast', 'anthropic/sample-large'] }
	});
	render(<StudioAssistantSidebar {...props()} />);
	await waitFor(() => expect(screen.getByLabelText('Agent backend')).toHaveValue('pi'));
	const model = screen.getByRole('combobox', { name: 'Agent model' });
	fireEvent.change(model, { target: { value: 'sample-fast' } });
	expect(screen.getByRole('option', { name: 'openai/sample-fast' })).toBeTruthy();
	expect(screen.queryByRole('option', { name: 'anthropic/sample-large' })).toBeNull();
	fireEvent.click(screen.getByRole('option', { name: 'openai/sample-fast' }));
	expect(model).toHaveValue('openai/sample-fast');
	fireEvent.change(model, { target: { value: 'my-custom-model' } });
	expect(model).toHaveValue('my-custom-model');
	fireEvent.change(screen.getByLabelText('Agent backend'), { target: { value: 'codex' } });
	expect(model).toHaveValue('');
});

it('uses the shared rendered verifier and explains when it is unavailable', async () => {
	const report = {
		ok: true,
		measured: true,
		checked: 1,
		issues: [],
		visualReviewRequired: true as const
	};
	for (const supported of [true, false]) {
		let finish!: () => void;
		vi.mocked(studioAgentPorts.run).mockImplementationOnce(
			(_request, receive) =>
				new Promise((resolve) => {
					finish = resolve;
					receive({ type: 'tool', id: 'verify', name: 'studio_verify', args: {} });
				})
		);
		const p = { ...props(), ...(supported ? { verify: vi.fn().mockResolvedValue(report) } : {}) };
		const view = render(<StudioAssistantSidebar {...p} />);
		await waitFor(() => expect(screen.getByLabelText('Agent backend')).toHaveValue('pi'));
		fireEvent.change(screen.getByLabelText('Message to studio assistant'), {
			target: { value: 'Verify my layout' }
		});
		fireEvent.click(screen.getByRole('button', { name: 'Send' }));
		if (supported)
			await waitFor(() =>
				expect(studioAgentPorts.reply).toHaveBeenCalledWith(expect.any(String), 'verify', report)
			);
		else await screen.findByText(/Rendered verification is unavailable/);
		await act(async () => finish());
		view.unmount();
	}
});
