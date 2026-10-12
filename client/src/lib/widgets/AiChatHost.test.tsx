import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: bridge.listen }));
import AiChatHost from './AiChatHost';
import { resetChat, handleDelta } from '../../stores/llmStore';
beforeEach(() => {
	vi.clearAllMocks();
	resetChat();
	bridge.listen.mockResolvedValue(vi.fn());
	bridge.invoke.mockResolvedValue(undefined);
});
it('sends a prompt, renders streamed replies, stops and clears the conversation', async () => {
	render(<AiChatHost />);
	expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
	fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
		target: { value: 'Hello' }
	});
	await act(async () => fireEvent.submit(screen.getByRole('form', { name: 'Ask AI' })));
	expect(screen.getByText('Hello')).toBeTruthy();
	const call = bridge.invoke.mock.calls.find(([cmd]) => cmd === 'llm_stream')!;
	expect(call).toBeTruthy();
	const id = call[1].requestId;
	act(() => handleDelta({ requestId: id, token: 'Hi there', done: false }));
	expect(screen.getByText('Hi there')).toBeTruthy();
	fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
	expect(bridge.invoke).toHaveBeenCalledWith('llm_cancel', { requestId: id });
	fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
	expect(screen.queryByText('Hi there')).toBeNull();
});
it('shows request errors and supports a custom title', async () => {
	bridge.invoke.mockRejectedValue('Configure an AI provider');
	render(<AiChatHost label="Desk helper" />);
	expect(screen.getByText('Desk helper')).toBeTruthy();
	fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Help' } });
	await act(async () => fireEvent.submit(screen.getByRole('form', { name: 'Ask AI' })));
	expect(screen.getByText('Configure an AI provider')).toBeTruthy();
});

it('ignores blank submissions and Enter while a reply is still streaming', async () => {
	render(<AiChatHost />);
	const form = screen.getByRole('form', { name: 'Ask AI' });
	await act(async () => fireEvent.submit(form));
	expect(bridge.invoke).not.toHaveBeenCalled();
	fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
		target: { value: 'First' }
	});
	await act(async () => fireEvent.submit(form));
	fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
		target: { value: 'Second' }
	});
	await act(async () => fireEvent.submit(form));
	expect(bridge.invoke.mock.calls.filter(([cmd]) => cmd === 'llm_stream')).toHaveLength(1);
	expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Second');
});
