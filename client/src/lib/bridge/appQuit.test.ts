import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { onAppQuitting } from './appQuit';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

const quitting = () =>
	vi.mocked(listen).mock.calls[0][1]({ id: 1, event: 'app_quitting', payload: null });

beforeEach(() => vi.clearAllMocks());

it('acknowledges Quit only after the pending writes have landed', async () => {
	let land: () => void = () => undefined;
	const flush = vi.fn(() => new Promise<void>((r) => (land = r)));
	await onAppQuitting(flush);
	expect(listen).toHaveBeenCalledWith('app_quitting', expect.any(Function));
	const handled = quitting();
	await vi.waitFor(() => expect(flush).toHaveBeenCalled());
	expect(invoke).not.toHaveBeenCalled();
	land();
	await handled;
	expect(invoke).toHaveBeenCalledWith('quit_flushed');
});

it('still acknowledges when the flush fails, so the exit is not held to the timeout', async () => {
	await onAppQuitting(() => Promise.reject(new Error('disk')));
	await quitting();
	expect(invoke).toHaveBeenCalledWith('quit_flushed');
});

it('a failed acknowledgement does not surface as an unhandled rejection', async () => {
	vi.mocked(invoke).mockRejectedValueOnce(new Error('window closing'));
	await onAppQuitting(() => Promise.resolve());
	await expect(quitting()).resolves.toBeUndefined();
});
