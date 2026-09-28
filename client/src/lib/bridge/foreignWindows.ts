import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from './contract';
import type { Rect } from '../core/layout';
import type { WindowDescriptor } from '../core/windowMatch';

/** Enumerate the arrangeable foreign top-level windows (for on-demand auto-arrange). Studio-only on
 * the backend; returns [] off-Windows or on failure so the caller never throws. */
export async function listWindows(): Promise<WindowDescriptor[]> {
	try {
		return await invoke<WindowDescriptor[]>(COMMANDS.listWindows);
	} catch (err) {
		console.warn('list_windows failed', err);
		return [];
	}
}

/** Snap the foreign window `hwnd` so its visible frame fills `rect` (PHYSICAL px). Returns whether
 * it succeeded — a false result (elevated target the backend can't touch, or off-Windows) is
 * surfaced for an in-UI notice rather than thrown. Studio-only on the backend. */
export async function snapWindow(hwnd: number, rect: Rect): Promise<boolean> {
	try {
		await invoke(COMMANDS.snapWindow, { hwnd, rect });
		return true;
	} catch (err) {
		console.warn('snap_window failed', err);
		return false;
	}
}

/** Cursor position (PHYSICAL px) + whether Shift is held — polled by the overlay during a foreign
 * window drag to highlight the hovered zone (windowmgr.rs `pointer_probe`). Falls back to a
 * not-armed origin off-Windows / on failure so the poll loop never throws. */
export async function pointerProbe(): Promise<{ x: number; y: number; shift: boolean }> {
	try {
		return await invoke<{ x: number; y: number; shift: boolean }>(COMMANDS.pointerProbe);
	} catch (err) {
		console.warn('pointer_probe failed', err);
		return { x: 0, y: 0, shift: false };
	}
}
