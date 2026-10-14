import { describe, expect, it } from 'vitest';
import {
	DEFAULT_EDIT_HOTKEY,
	EDIT_HOTKEY_OFF,
	EDIT_HOTKEY_PRESETS,
	editExitKeys,
	editHotkeyLabel,
	editHotkeyOptions
} from './editHotkey';

describe('editHotkey presets', () => {
	it('defaults to Ctrl+Alt+E, offers Off, and never offers the rescue chord', () => {
		expect(DEFAULT_EDIT_HOTKEY).toBe('Ctrl+Alt+E');
		expect(EDIT_HOTKEY_PRESETS[0]).toMatchObject({ value: 'Ctrl+Alt+E', hint: 'default' });
		expect(EDIT_HOTKEY_PRESETS.map((p) => p.value)).toContain(EDIT_HOTKEY_OFF);
		const normalized = EDIT_HOTKEY_PRESETS.map((p) => p.value.split('+').sort().join('+'));
		expect(normalized).not.toContain(['Alt', 'Ctrl', 'E', 'Shift'].join('+'));
	});

	it('keeps a custom (hand-edited) value selectable alongside the presets', () => {
		expect(editHotkeyOptions('Win+Alt+E')).toEqual([...EDIT_HOTKEY_PRESETS]);
		expect(editHotkeyOptions('Ctrl+Alt+K')).toEqual([
			...EDIT_HOTKEY_PRESETS,
			{ value: 'Ctrl+Alt+K', label: 'Ctrl+Alt+K', hint: 'custom' }
		]);
	});
});

describe('editExitKeys', () => {
	it.each([
		['unknown status → the default chord', null, 'Ctrl+Alt+E'],
		['registered chord', { hotkey: 'Win+Alt+E', active: true, error: null }, 'Win+Alt+E'],
		['turned off → the in-window Ctrl+E', { hotkey: 'Off', active: false, error: null }, 'Ctrl+E'],
		[
			'registration failed → the in-window Ctrl+E',
			{ hotkey: 'Ctrl+Alt+E', active: false, error: 'taken' },
			'Ctrl+E'
		]
	] as const)('%s', (_name, status, keys) => {
		expect(editExitKeys(status)).toBe(keys);
	});
});

describe('editHotkeyLabel', () => {
	it.each([
		['registered chord', { hotkey: 'Win+Alt+E', active: true, error: null }, 'Win+Alt+E'],
		['turned off', { hotkey: 'Off', active: false, error: null }, 'Off'],
		[
			'registration failed',
			{ hotkey: 'Ctrl+Alt+E', active: false, error: 'taken' },
			'Ctrl+Alt+E (not registered)'
		]
	] as const)('%s', (_name, status, label) => {
		expect(editHotkeyLabel(status)).toBe(label);
	});
});
