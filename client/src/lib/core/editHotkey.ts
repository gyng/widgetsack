// Pure domain for the configurable global edit-mode hotkey (AGENTS.md §5: no React/Tauri here). The
// backend (widgetsack/src/hotkey.rs) validates, persists and registers the accelerator; this module
// owns the studio's preset list and the small labels the Settings tab and the overlay's edit badge
// share.

/** The default chord (unchanged from before it was configurable). */
export const DEFAULT_EDIT_HOTKEY = 'Ctrl+Alt+E';
/** The stored value meaning "no global edit hotkey". */
export const EDIT_HOTKEY_OFF = 'Off';

/** Status of the edit hotkey. Mirrors `EditHotkeyStatus` in widgetsack/src/hotkey.rs. */
export type EditHotkeyStatus = {
	/** The configured accelerator (`'Off'` for none). */
	hotkey: string;
	/** Registered right now (false for Off, or when registration failed). */
	active: boolean;
	/** Why registration failed, if it did. */
	error: string | null;
};

export type EditHotkeyOption = { value: string; label: string; hint?: string };

// Presets only (no free-text capture): every one parses on the Rust side, none collides with the
// fixed rescue chord (Ctrl+Alt+Shift+E), and the non-default ones avoid Ctrl+Alt (= AltGr).
export const EDIT_HOTKEY_PRESETS: readonly EditHotkeyOption[] = [
	{ value: DEFAULT_EDIT_HOTKEY, label: DEFAULT_EDIT_HOTKEY, hint: 'default' },
	{ value: 'Win+Alt+E', label: 'Win+Alt+E' },
	{ value: 'Ctrl+Shift+F9', label: 'Ctrl+Shift+F9' },
	{ value: EDIT_HOTKEY_OFF, label: 'Off (no global shortcut)' }
];

/** The picker's options: the presets, plus the current value when it isn't one of them (a
 *  hand-edited prefs.json) so the picker can still show what is configured. */
export function editHotkeyOptions(current: string): EditHotkeyOption[] {
	if (EDIT_HOTKEY_PRESETS.some((p) => p.value === current)) return [...EDIT_HOTKEY_PRESETS];
	return [...EDIT_HOTKEY_PRESETS, { value: current, label: current, hint: 'custom' }];
}

/** What the overlay's edit badge should name as the way out: the global chord when it is
 *  registered, else the in-window Ctrl+E (status unknown yet → the default chord). */
export function editExitKeys(status: EditHotkeyStatus | null): string {
	if (!status) return DEFAULT_EDIT_HOTKEY;
	return status.active ? status.hotkey : 'Ctrl+E';
}
