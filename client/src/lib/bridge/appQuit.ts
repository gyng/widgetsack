// Tray Quit waits (bounded, backend-side) for every window to land its pending writes: on
// `app_quitting` this window flushes, then acknowledges with `quit_flushed` — even if the flush
// failed, so the exit never waits out the full timeout on a window that already gave up.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { COMMANDS, EVENTS } from './contract';

export function onAppQuitting(flush: () => Promise<unknown>): Promise<UnlistenFn> {
	return listen(EVENTS.appQuitting, async () => {
		try {
			await flush();
		} catch {
			// nothing more to save; still let the app exit promptly
		}
		await invoke(COMMANDS.quitFlushed).catch(() => undefined);
	});
}
