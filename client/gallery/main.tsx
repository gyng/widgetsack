// Gallery entry. Runs in a plain browser (no Tauri): freeze the clock and seed the media store, then
// render. We deliberately do NOT install the Tauri dev mock — the now-playing widget's startup calls
// (get_initial_sessions / media_capabilities) then simply reject and are caught, leaving our seeded
// session intact (the mock would answer get_initial_sessions with an empty set and wipe it).
import { createRoot } from 'react-dom/client';
import { freezeClock, seedMedia } from './seed';
import Gallery from './Gallery';

// Minimal Tauri stub: in a plain browser `invoke()` would sync-throw on `transformCallback`. Resolve
// `undefined` for most commands — un-awaited `listen()` calls then settle cleanly (no unhandled
// rejection), and get_initial_sessions' `.then(ev => ...ev.sessions)` throws on undefined → caught by
// its own `.catch`, leaving the seeded media session intact (the full dev mock would return an empty
// set and wipe it). The Audio Switcher + Volume widgets source from commands (not the hub), so a few
// audio commands return canned data here so they render a representative shot.
const GALLERY_INVOKE: Record<string, unknown> = {
	list_audio_outputs: [
		{ id: 'spk', name: 'Speakers (Realtek)' },
		{ id: 'hp', name: 'Headphones (USB)' },
		{ id: 'hdmi', name: 'HDMI Display' }
	],
	default_audio_output: 'spk',
	get_audio_volume: { level: 0.62, muted: false },
	// The Monitor Switch sources its rows from list_monitor_inputs (DDC/CI VCP 0x60), not the hub —
	// canned a representative 4K monitor (current = HDMI 1; DP/HDMI×2/USB-C supported) so it renders.
	list_monitor_inputs: [
		{
			gdi: '\\\\.\\DISPLAY1',
			friendly: 'Dell U2723QE',
			primary: true,
			current_input: 0x11, // HDMI 1
			supported: [0x0f, 0x11, 0x12, 0x15], // DisplayPort 1, HDMI 1, HDMI 2, USB-C
			width: 2560,
			height: 1440,
			refresh_hz: 144
		}
	]
};
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__TAURI_INTERNALS__ = {
	transformCallback: (cb: unknown) => cb,
	invoke: (cmd: string) => Promise.resolve(cmd in GALLERY_INVOKE ? GALLERY_INVOKE[cmd] : undefined)
};

async function boot(): Promise<void> {
	freezeClock();
	// Seed the Sticky Note's localStorage (keyed by the gallery instance id) so it shows real text.
	try {
		localStorage.setItem('scratch:w-note', '• Ship v0.0.34\n• Water the plants\n• Reply to Sam');
	} catch {
		/* localStorage unavailable */
	}
	await seedMedia();
	const root = document.getElementById('root');
	if (root) createRoot(root).render(<Gallery />);
}

void boot();
