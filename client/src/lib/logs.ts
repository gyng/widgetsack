// Outer-ring adapter for the backend's structured log stream (widgetsack/src/log.rs). A future
// in-app logs UI uses `getLogs()` for the backlog (the in-memory ring buffer) and `subscribeLogs()`
// for live entries (the `log` Tauri event). Tauri stays at this edge; the LogRecord type is pure
// (core/logs.ts).
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { LogRecord } from './core/logs';
import { COMMANDS, EVENTS } from './bridge/contract';

/** The buffered log backlog (oldest first) for a UI that opens after entries were produced. */
export function getLogs(): Promise<LogRecord[]> {
	return invoke<LogRecord[]>(COMMANDS.getLogs).catch(() => []);
}

/** Stream new log entries as the backend emits them. Returns an unlisten function. */
export function subscribeLogs(cb: (record: LogRecord) => void): Promise<UnlistenFn> {
	return listen<LogRecord>(EVENTS.log, (ev) => cb(ev.payload));
}

/** Absolute path of the rotating on-disk log (diag.rs), or `null` outside Tauri / on failure. */
export function getLogFilePath(): Promise<string | null> {
	return invoke<string>(COMMANDS.logFilePath).catch(() => null);
}

/** Open the log folder in Explorer (diag.rs). Best-effort: resolves whether it worked. */
export function revealLogDir(): Promise<boolean> {
	return invoke(COMMANDS.revealLogDir).then(
		() => true,
		() => false
	);
}
