import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useRecording } from './useRecording';
import { startRecording, type Recorder } from './stt';
vi.mock('./stt', () => ({ startRecording: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it('releases a microphone acquired after unmount', async () => {
	let ready!: (rec: Recorder) => void;
	vi.mocked(startRecording).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				ready = resolve;
			})
	);
	const consume = vi.fn();
	const { result, unmount } = renderHook(() => useRecording(consume));
	let pending!: Promise<void>;
	act(() => {
		pending = result.current.toggle();
	});
	unmount();
	const cancel = vi.fn();
	await act(async () => {
		ready({ cancel, stop: vi.fn() });
		await pending;
	});
	expect(cancel).toHaveBeenCalledOnce();
	expect(consume).not.toHaveBeenCalled();
});
it('serializes acquisition and processing and invalidates processing on unmount', async () => {
	const cancel = vi.fn();
	const rec = {
		cancel,
		stop: vi.fn(async () => ({ bytes: new Uint8Array(), mime: 'audio/webm' }))
	};
	vi.mocked(startRecording).mockResolvedValueOnce(rec);
	let finish!: () => void;
	let current!: () => boolean;
	const consume = vi.fn(async (_recording: unknown, valid: () => boolean) => {
		current = valid;
		await new Promise<void>((r) => {
			finish = r;
		});
	});
	const { result, unmount } = renderHook(() => useRecording(consume));
	await act(async () => {
		await Promise.all([result.current.toggle(), result.current.toggle()]);
	});
	expect(startRecording).toHaveBeenCalledOnce();
	let processing!: Promise<void>;
	await act(async () => {
		processing = result.current.toggle();
		await Promise.resolve();
	});
	await act(async () => {
		await result.current.toggle();
	});
	expect(consume).toHaveBeenCalledOnce();
	expect(current()).toBe(true);
	unmount();
	expect(current()).toBe(false);
	finish();
	await processing;
});
