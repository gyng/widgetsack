// DEV-ONLY Tauri shim. Lets the SPA boot in a PLAIN browser (`npm run dev`, no Tauri runtime) so the
// layout + interactions can be driven/screenshotted by Playwright. It is installed ONLY in dev when
// there is no real Tauri context (the actual WebView always has `window.__TAURI_INTERNALS__`), and is
// stripped from production builds (`cargo tauri build` sets `import.meta.env.DEV` false → dead-code
// eliminated). It forces the STUDIO role and answers the boot commands with empty/canned data; the
// goal is a clean-booting editor to exercise, not real telemetry.
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { COMMANDS } from './bridge/contract';

const MONITOR = {
	name: 'Mock-1920',
	size: { width: 1920, height: 1080 },
	position: { x: 0, y: 0 },
	// workArea is required by @tauri-apps/api's mapMonitor (it reads workArea.position/.size); omitting
	// it makes primaryMonitor()/currentMonitor() throw "reading 'position'" → an 'overlay init failed' warn.
	workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1032 } },
	scaleFactor: 1
};

export function installDevMock(opts: { layout?: string } = {}): void {
	// Current window label === 'studio' → App.isStudioWindow() picks the editor role.
	mockWindows('studio');

	let evtId = 0;
	mockIPC((cmd, args) => {
		switch (cmd) {
			// --- boot: persistence / themes / controls / fonts (empty so the studio opens blank,
			// unless the caller supplies a canned layout — the screenshot rig does) ---
			case COMMANDS.loadLayout:
				return opts.layout ?? null;
			case COMMANDS.loadControls:
			case COMMANDS.loadTheme:
			case COMMANDS.readSack:
			case COMMANDS.readPluginPackageAsset:
				return null;
			case COMMANDS.installPluginPackage:
			case COMMANDS.checkPluginPackageUpdate:
			case COMMANDS.packageFetch:
				// No network in the mock — throw so the panel surfaces an honest failure (mirrors
				// llmSynthesize) instead of pretending an install/check/fetch succeeded.
				throw new Error('no network in dev mock');
			case COMMANDS.removePluginPackage:
				return undefined;
			case COMMANDS.listThemes:
			case COMMANDS.listSacks:
			case COMMANDS.listPluginPackages:
			case COMMANDS.listWallpapers:
			case COMMANDS.getLogs:
			case COMMANDS.systemFonts:
			case COMMANDS.listDisplayNames:
				// 'list_display_names' (Windows-only friendly monitor names) has no real displays under the
				// mock, so the switcher falls back to the device tag — and the boot stays self-policing.
				return [];
			case COMMANDS.currentWorkArea:
				return { x: 0, y: 0, w: MONITOR.size.width, h: MONITOR.size.height - 48 };

			// --- media (now-playing): no sessions / no caps ---
			case COMMANDS.getInitialSessions:
				return { sessions: {} };
			case COMMANDS.mediaCapabilities:
				return null;

			// --- window / monitor plugin: one fake 1920×1080 monitor (empty list → no multi-monitor UI) ---
			case 'plugin:window|available_monitors':
				return [];
			case 'plugin:window|current_monitor':
			case 'plugin:window|primary_monitor':
				return MONITOR;

			// --- event plugin: listen returns a handle id; everything else resolves ---
			case 'plugin:event|listen':
				return ++evtId;

			// --- autostart ---
			case COMMANDS.autostartIsEnabled:
				return false;

			// --- Home Assistant proxy: not configured, no entities. Catalogs MUST be [] (not null) —
			// ha-source caches the result and later .map()s it; a null would throw on the next read. ---
			case COMMANDS.haConnect:
			case COMMANDS.haDisconnect:
				return undefined;
			case COMMANDS.listHaEntities:
				// A few canned entities so the dev studio's sensor typeahead has something to filter/pick
				// (there's no live telemetry under the mock). Shape mirrors HaEntity (ha-types.ts).
				return [
					{ entity_id: 'sensor.cpu_load', state: '12', friendly_name: 'CPU Load', unit: '%' },
					{
						entity_id: 'sensor.cpu_temp',
						state: '54',
						friendly_name: 'CPU Temperature',
						unit: '°C'
					},
					{ entity_id: 'sensor.memory_used', state: '41', friendly_name: 'Memory Used', unit: '%' },
					{ entity_id: 'light.kitchen', state: 'on', friendly_name: 'Kitchen Light' }
				];
			case COMMANDS.haConfigStatus:
				return { configured: false, url: null, insecure: false, base_path: '' };
			case COMMANDS.haRegistrySnapshot:
				return { areas: [], devices: [], entities: [] };
			case COMMANDS.haTestConnection:
				return { ha_version: null };

			// --- MQTT proxy: not configured, empty catalog (same []-not-null rule as HA). ---
			case COMMANDS.mqttConnect:
			case COMMANDS.mqttDisconnect:
				return undefined;
			case COMMANDS.mqttCatalog:
				return [];
			case COMMANDS.mqttConfigStatus:
				return {
					configured: false,
					host: '',
					port: 1883,
					username: '',
					topics: [],
					tls: false,
					insecure: false,
					discovery: false
				};

			// --- audio outputs (the Spectrum widget's device picker + the Audio Switcher) ---
			case COMMANDS.listAudioOutputs:
				return [
					{ id: 'dev-speakers', name: 'Speakers (Realtek)' },
					{ id: 'dev-headphones', name: 'Headphones (USB)' },
					{ id: 'dev-hdmi', name: 'HDMI Display' }
				];
			case COMMANDS.defaultAudioOutput:
				return 'dev-speakers';
			case COMMANDS.setDefaultAudioOutput:
				return undefined;

			// --- stocks proxy: not configured (mirrors HA/MQTT; shape = StocksStatus). ---
			case COMMANDS.stocksConnect:
			case COMMANDS.stocksDisconnect:
				return undefined;
			case COMMANDS.stocksConfigStatus:
				return { configured: false, provider: '', symbols: [], pollSeconds: 60 };

			// --- AI provider: not configured (shape = LlmStatus). `llm_complete` returns canned layout
			// ops so the layout assistant is exercisable under Playwright without a real model. ---
			case COMMANDS.llmConfigStatus:
				return {
					configured: false,
					active: 'openai',
					providers: {},
					temperature: 0.7,
					maxTokens: 1024,
					agentControl: false
				};
			case COMMANDS.controlStart:
			case COMMANDS.controlStop:
				return undefined;
			case COMMANDS.llmTestConnection:
				return { model: 'mock', reply: 'OK' };
			case COMMANDS.llmListModels:
				return [];
			case COMMANDS.llmComplete:
				return '{"ops":[{"op":"addWidget","widgetType":"clock"}],"summary":"added a clock (mock)"}';
			case COMMANDS.llmStream:
			case COMMANDS.llmCancel:
				return undefined;
			case COMMANDS.llmTranscribe:
				return 'add a clock to the top left'; // canned transcript so the mic flow is testable in dev
			case COMMANDS.llmSynthesize:
				// No provider TTS in dev — reject so speakSmart falls back to the browser voice.
				throw new Error('no provider TTS in dev mock');

			// --- wallpapers (Background section) ---
			case COMMANDS.wallpaperPath:
				return `C:/mock/wallpapers/${(args as { name?: string } | undefined)?.name ?? ''}`;
			case COMMANDS.openWallpapersDir:
				return null;

			// --- widget actuation (only fired by clicking a live control, never at boot) ---
			case COMMANDS.mediaControl:
			case COMMANDS.haCallService:
				return null;

			default:
				// Plugin no-ops (event unlisten, window setters), saves, devtools, set_* → resolve void.
				// HA/MQTT + anything unhandled → null (only called when those panels are opened). Log it so
				// a genuinely missing boot command is visible in the console during a Playwright run.
				if (
					cmd.startsWith('plugin:') ||
					cmd.startsWith('save_') ||
					cmd.startsWith('set_') ||
					cmd === COMMANDS.openDevtools ||
					cmd === COMMANDS.writeSack
				) {
					return undefined;
				}
				console.warn('[devMock] unhandled command', cmd, args);
				return null;
		}
	});
}
