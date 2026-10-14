import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { followOverlayEdit, toggleOverlayEdit } from './editMode';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

let fire: (payload: unknown) => void = () => undefined;
const unlisten = vi.fn();

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	vi.mocked(listen).mockReset();
	vi.mocked(listen).mockImplementation(async (_name, cb) => {
		fire = (payload) => cb({ id: 1, event: 'toggle_edit', payload });
		return unlisten;
	});
});

describe('overlay edit mode bridge', () => {
	it('toggles through the backend command', async () => {
		vi.mocked(invoke).mockResolvedValue(true);
		await expect(toggleOverlayEdit()).resolves.toBe(true);
		expect(invoke).toHaveBeenCalledWith('toggle_overlay_edit');
	});

	it('a joining window adopts the current shared state', async () => {
		vi.mocked(invoke).mockResolvedValue(true);
		const apply = vi.fn();
		await expect(followOverlayEdit(apply)).resolves.toBe(unlisten);
		expect(listen).toHaveBeenCalledWith('toggle_edit', expect.any(Function));
		expect(invoke).toHaveBeenCalledWith('get_overlay_edit');
		expect(apply).toHaveBeenCalledWith(true);
	});

	it('broadcasts SET the state: the same value twice never flips a window back', async () => {
		vi.mocked(invoke).mockResolvedValue(false);
		const apply = vi.fn();
		await followOverlayEdit(apply);
		apply.mockClear();
		fire(true);
		fire(true);
		fire(false);
		fire(undefined); // a legacy payload-less toggle is ignored, not treated as a flip
		expect(apply.mock.calls).toEqual([[true], [true], [false]]);
	});

	it('a broadcast landing during the join read wins over the (older) read', async () => {
		let resolveRead: (v: boolean) => void = () => undefined;
		vi.mocked(invoke).mockReturnValue(new Promise((r) => (resolveRead = r)));
		const apply = vi.fn();
		const joined = followOverlayEdit(apply);
		await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
		fire(true);
		resolveRead(false);
		await joined;
		expect(apply.mock.calls).toEqual([[true]]);
	});

	it('a failed read keeps the window as it is', async () => {
		vi.mocked(invoke).mockRejectedValue(new Error('gone'));
		const apply = vi.fn();
		await followOverlayEdit(apply);
		expect(apply).not.toHaveBeenCalled();
	});
});
