// Overlay edit mode is owned by the backend (command/windows.rs OverlayEditState): Ctrl+E and the
// global hotkey flip it there, and `toggle_edit` broadcasts the resulting state. Windows SET that
// state rather than flipping their own, so a window created or reloaded mid-edit joins in the right
// mode instead of ending up permanently opposite to the others.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { COMMANDS, EVENTS } from './contract';

/** Flip overlay edit mode for every window (the backend broadcasts the new state). */
export function toggleOverlayEdit(): Promise<boolean> {
	return invoke<boolean>(COMMANDS.toggleOverlayEdit);
}

/** Follow the shared overlay edit state: apply every broadcast, plus the current state at join —
 * unless a broadcast already landed while the read was in flight (the broadcast is newer). A failed
 * read keeps the window's own mode. Resolves to the unlisten once the join read has settled. */
export async function followOverlayEdit(apply: (edit: boolean) => void): Promise<UnlistenFn> {
	let heard = false;
	const unlisten = await listen<unknown>(EVENTS.toggleEdit, (event) => {
		if (typeof event.payload !== 'boolean') return; // not the state-carrying contract
		heard = true;
		apply(event.payload);
	});
	const current = await invoke<boolean>(COMMANDS.getOverlayEdit).catch(() => null);
	if (!heard && typeof current === 'boolean') apply(current);
	return unlisten;
}
