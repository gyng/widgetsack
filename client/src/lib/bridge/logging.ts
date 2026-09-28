import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from './contract';

/** Route an overlay-lifecycle failure to BOTH this window's console (so a live devtools session
 *  still sees it) and the backend's persistent rotating log file (so it survives the webview
 *  dying with the app — the whole point of last night's silent-death postmortem). Best-effort:
 *  the backend `log_client` invoke NEVER throws or recurses into this helper, so a logging
 *  failure can't itself take down the overlay. `component` names the caller's subsystem
 *  ('overlay', 'layout', …); put queryable details (role, duration, monitor key) in `fields`.
 *  Exported for the OTHER boot-path choke points (Canvas reloadLayout, useStudioInit's init catch)
 *  so no startup failure is ever console-only again. */
export function logClient(
	level: 'info' | 'warn' | 'error',
	component: string,
	message: string,
	fields?: Record<string, string>
): void {
	if (level === 'error') console.error(`[${component}] ${message}`);
	else if (level === 'warn') console.warn(`[${component}] ${message}`);
	else console.info(`[${component}] ${message}`);
	invoke(COMMANDS.logClient, { level, component, message, fields }).catch(() => undefined);
}
