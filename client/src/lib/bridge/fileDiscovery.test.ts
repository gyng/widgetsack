import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listLayouts, saveLayoutAs } from './layouts';
import { listThemes, loadThemeCss, resolveThemeCss, saveThemeCss } from './themes';
import { COMMANDS } from './contract';
import { listSacks, writeSack } from './sacks';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

it('rejects missing and unreadable theme contents used for editing or export', async () => {
	const error = new Error('Access denied');
	vi.mocked(invoke).mockRejectedValueOnce(error);
	await expect(loadThemeCss('Nord', true)).rejects.toBe(error);
	vi.mocked(invoke).mockResolvedValueOnce(null);
	await expect(resolveThemeCss('Nord', true)).rejects.toThrow('not found');
	vi.mocked(invoke).mockResolvedValueOnce('');
	await expect(loadThemeCss('Empty', true)).resolves.toBe('');
});

it('forwards the no-overwrite policy to native theme and preset writes', async () => {
	vi.mocked(invoke).mockResolvedValue('saved');
	await saveThemeCss('Nord', ':root{}', false);
	expect(invoke).toHaveBeenCalledWith(COMMANDS.saveTheme, {
		name: 'Nord',
		contents: ':root{}',
		overwrite: false
	});
	await saveLayoutAs('Home', '{}', false);
	expect(invoke).toHaveBeenCalledWith(COMMANDS.saveLayoutAs, {
		name: 'Home',
		contents: '{}',
		overwrite: false
	});
	await writeSack('Shared', '{}', false);
	expect(invoke).toHaveBeenCalledWith(COMMANDS.writeSack, {
		name: 'Shared',
		contents: '{}',
		overwrite: false
	});
});

it.each([listLayouts, listThemes, listSacks])(
	'does not hide discovery errors during a write preflight',
	async (list) => {
		const error = new Error('Access denied');
		vi.mocked(invoke).mockRejectedValueOnce(error);
		await expect(list(true)).rejects.toBe(error);
	}
);

it.each([listLayouts, listThemes, listSacks])(
	'keeps display-only discovery available when disk access fails',
	async (list) => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		vi.mocked(invoke).mockRejectedValueOnce(new Error('Access denied'));
		await expect(list()).resolves.toEqual(expect.any(Array));
	}
);
