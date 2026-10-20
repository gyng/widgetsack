import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../bridge/contract';

export async function registerCustomHtml(
	token: string,
	document: string
): Promise<{ url?: string; srcDoc?: string }> {
	const url = await invoke<string | null>(COMMANDS.registerCustomHtml, { token, document });
	if (typeof url === 'string' && url.startsWith('http://customhtml.localhost/')) return { url };
	// Plain-browser Studio uses devMock, which has no native URI handler or restrictive app CSP.
	if (import.meta.env.DEV && !url) return { srcDoc: document };
	throw new Error('Custom HTML document registration failed');
}

export function releaseCustomHtml(token: string): Promise<void> {
	// Closing/reloading a webview can tear IPC down before cleanup finishes.
	return invoke<void>(COMMANDS.releaseCustomHtml, { token }).catch(() => undefined);
}
