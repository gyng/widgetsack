// Outer-ring adapter (AGENTS.md §5) for the Monitor Switch widget: list monitors with their current /
// supported DDC input + display mode, and switch the input. Tauri lives here, never in the meter or
// core/. Command names mirror widgetsack/src/ddc.rs; `MonitorInputs` mirrors the Rust struct of the
// same name.

import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../bridge/contract';

/** One monitor's input-switching state. Mirrors `MonitorInputs` in widgetsack/src/ddc.rs. Keyed by
 *  `gdi` (`\\.\DISPLAYn`). `currentInput` / `supported` are DDC/CI (VCP 0x60) and only filled for the
 *  queried target; `width`/`height`/`refreshHz` are the OS display mode (0 if unknown). */
export type MonitorInputs = {
	gdi: string;
	friendly: string;
	primary: boolean;
	current_input: number | null;
	supported: number[];
	width: number;
	height: number;
	refresh_hz: number;
};

/** All monitors; DDC (current/supported) is filled only for `target` (a GDI device name) — or the
 *  primary monitor when omitted. Empty list off-Windows / on failure. */
export async function listMonitorInputs(target?: string): Promise<MonitorInputs[]> {
	try {
		return (
			(await invoke<MonitorInputs[]>(COMMANDS.listMonitorInputs, { target: target ?? null })) ?? []
		);
	} catch (err) {
		console.warn('list_monitor_inputs failed', err);
		return [];
	}
}

/** Switch `target` (a GDI device name) to VCP 0x60 input `value`. Resolves true on success, false on
 *  failure (DDC/CI off, monitor not found, or an unsupported value) so the host can roll back. */
export async function setMonitorInput(target: string, value: number): Promise<boolean> {
	try {
		await invoke(COMMANDS.setMonitorInput, { target, value });
		return true;
	} catch (err) {
		console.warn('set_monitor_input failed', err);
		return false;
	}
}
