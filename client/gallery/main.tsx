// Gallery entry: freeze the clock, seed illustrative data, and render in a browser without Tauri.
import { createRoot } from 'react-dom/client';
import { freezeClock, seedMedia } from './seed';
import Gallery from './Gallery';
import { mediaStore } from '../src/stores/stores';

// Minimal Tauri stub: listeners settle cleanly, the media snapshot preserves the seeded track,
// and command-backed widgets receive canned data without accessing devices or the network.
const GALLERY_INVOKE: Record<string, unknown> = {
	list_audio_outputs: [
		{ id: 'spk', name: 'Speakers (Realtek)' },
		{ id: 'hp', name: 'Headphones (USB)' },
		{ id: 'hdmi', name: 'HDMI Display' }
	],
	default_audio_output: 'spk',
	get_audio_volume: { level: 0.62, muted: false },
	get_audio_mixer: {
		sessions: [
			{ id: 'player', name: 'Music player', level: 0.65, muted: false },
			{ id: 'browser', name: 'Browser', level: 0.3, muted: true }
		],
		microphone: { level: 1, muted: true }
	},
	check_service_health: { status: 200, latencyMs: 24, certificateDays: 45, error: null },
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
	invoke: (cmd: string) =>
		Promise.resolve(
			cmd === 'get_initial_sessions'
				? { sessions: mediaStore.getSnapshot().sessions }
				: cmd in GALLERY_INVOKE
					? GALLERY_INVOKE[cmd]
					: undefined
		)
};

async function boot(): Promise<void> {
	freezeClock();
	for (const [id, tasks] of Object.entries({
		'dashboard-work-2': [
			{ id: 'review', text: 'Review today’s agenda', done: true },
			{ id: 'ship', text: 'Ship the update', done: false },
			{ id: 'reply', text: 'Reply to Sam', done: false }
		],
		'dashboard-home-4': [
			{ id: 'plants', text: 'Water the plants', done: true },
			{ id: 'shopping', text: 'Pick up groceries', done: false }
		]
	}))
		localStorage.setItem(`checklist:preset/${id}`, JSON.stringify(tasks));
	// Seed the Sticky Note's localStorage (keyed by the gallery instance id) so it shows real text.
	try {
		localStorage.setItem('scratch:w-note', '• Ship v0.0.34\n• Water the plants\n• Reply to Sam');
		localStorage.setItem(
			'checklist:w-checklist',
			'[{"id":"one","text":"Review today’s agenda","done":true},{"id":"two","text":"Ship the update","done":false}]'
		);
	} catch {
		/* localStorage unavailable */
	}
	await seedMedia();
	const root = document.getElementById('root');
	if (root) createRoot(root).render(<Gallery />);
}

void boot();
