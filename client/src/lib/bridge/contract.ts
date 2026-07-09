// The Rust↔TS bridge contract: every Tauri event name and invoke command name as a single
// constant, so the two sides can't silently drift. MUST mirror widgetsack/src/bridge.rs —
// when a wire string changes, update both files in the same change (AGENTS.md §5/§8).
// Pure data (no imports, no Tauri): safe to import from any ring.

/** Tauri event names (Rust `emit` → TS `listen`, plus a few client↔client broadcasts). */
export const EVENTS = {
	// telemetry / streaming (sensors.rs + ha/mqtt/stocks; llm.rs; log.rs)
	telemetry: 'telemetry',
	llmDelta: 'llm_delta',
	log: 'log',
	// media session deltas (state.rs::updater kinds → event.rs::emit_to_bridge)
	sessionCreate: 'session_create',
	sessionUpdate: 'session_update',
	sessionDelete: 'session_delete',
	// config-file watchers (command.rs)
	layoutChanged: 'layout_changed',
	themesChanged: 'themes_changed',
	controlsChanged: 'controls_changed',
	// tray / global-hotkey / single-instance broadcasts (main.rs; toggle_edit is also
	// emitted by the client's Ctrl+E handler)
	toggleEdit: 'toggle_edit',
	openStudio: 'open_studio',
	arrangeZones: 'arrange_zones',
	// re-fit overlays to the current display layout (tray "Re-fit overlays" + auto on display change)
	refitOverlays: 'refit_overlays',
	// foreign-window drag watcher (windowmgr.rs)
	winDragStart: 'win_drag_start',
	winDragEnd: 'win_drag_end',
	// client↔client only (never emitted by Rust; centralized for the same one-source reason)
	overlayLayerStatus: 'overlay_layer_status',
	diagRequest: 'diag:request',
	diagReport: 'diag:report'
} as const;

/** Tauri invoke command names (TS `invoke` → the `#[tauri::command]` fns registered in
 * widgetsack/src/main.rs `invoke_handler`; a command's wire name IS its Rust fn name). */
export const COMMANDS = {
	// media / now-playing (command.rs, media.rs)
	getInitialSessions: 'get_initial_sessions',
	// dev/extra-instance flag (main.rs) — drives the studio's "dev" badge
	isDevInstance: 'is_dev_instance',
	mediaControl: 'media_control',
	mediaCapabilities: 'media_capabilities',
	// layout persistence + saved layout profiles (command.rs)
	loadLayout: 'load_layout',
	saveLayout: 'save_layout',
	listLayouts: 'list_layouts',
	readLayout: 'read_layout',
	saveLayoutAs: 'save_layout_as',
	deleteLayout: 'delete_layout',
	// control remaps (command.rs)
	loadControls: 'load_controls',
	saveControls: 'save_controls',
	// themes (command.rs)
	listThemes: 'list_themes',
	loadTheme: 'load_theme',
	saveTheme: 'save_theme',
	deleteTheme: 'delete_theme',
	// wallpapers (command.rs)
	listWallpapers: 'list_wallpapers',
	wallpaperPath: 'wallpaper_path',
	openWallpapersDir: 'open_wallpapers_dir',
	// sacks (command.rs)
	listSacks: 'list_sacks',
	readSack: 'read_sack',
	writeSack: 'write_sack',
	// third-party plugin packages (command.rs)
	listPluginPackages: 'list_plugin_packages',
	readPluginPackageAsset: 'read_plugin_package_asset',
	installPluginPackage: 'install_plugin_package',
	checkPluginPackageUpdate: 'check_plugin_package_update',
	removePluginPackage: 'remove_plugin_package',
	packageFetch: 'package_fetch',
	// foreign windows / monitors / click-through (windowmgr.rs, clickthrough.rs, display.rs)
	listWindows: 'list_windows',
	snapWindow: 'snap_window',
	pointerProbe: 'pointer_probe',
	setInteractiveRects: 'set_interactive_rects',
	currentWorkArea: 'current_work_area',
	setOverlayWallpaper: 'set_overlay_wallpaper',
	listDisplayNames: 'list_display_names',
	// monitor input-source switcher — DDC/CI VCP 0x60 (ddc.rs, the Monitor Switch widget)
	listMonitorInputs: 'list_monitor_inputs',
	setMonitorInput: 'set_monitor_input',
	// devtools / diagnostics / recovery (command.rs, process_diag.rs, log.rs)
	openDevtools: 'open_devtools',
	listWindowLabels: 'list_window_labels',
	openDevtoolsFor: 'open_devtools_for',
	setWindowInteractive: 'set_window_interactive',
	rescueWindows: 'rescue_windows',
	reloadWindow: 'reload_window',
	logDiag: 'log_diag',
	logClient: 'log_client',
	processDiagnostics: 'process_diagnostics',
	setSubsystemProfiling: 'set_subsystem_profiling',
	subsystemTimings: 'subsystem_timings',
	getLogs: 'get_logs',
	// app update check — GitHub latest release vs the running version (command.rs)
	checkAppUpdate: 'check_app_update',
	// fonts (command.rs)
	systemFonts: 'system_fonts',
	// sensors / telemetry demand-gating (sensors.rs)
	setActiveSensors: 'set_active_sensors',
	// audio spectrum (audio.rs)
	startSpectrum: 'start_spectrum',
	stopSpectrum: 'stop_spectrum',
	listAudioOutputs: 'list_audio_outputs',
	defaultAudioOutput: 'default_audio_output',
	setDefaultAudioOutput: 'set_default_audio_output',
	getAudioVolume: 'get_audio_volume',
	setAudioVolume: 'set_audio_volume',
	setAudioMute: 'set_audio_mute',
	// Home Assistant proxy (ha.rs)
	haConnect: 'ha_connect',
	haDisconnect: 'ha_disconnect',
	listHaEntities: 'list_ha_entities',
	haRegistrySnapshot: 'ha_registry_snapshot',
	haCallService: 'ha_call_service',
	haHistory: 'ha_history',
	haMediaArt: 'ha_media_art',
	saveHaConfig: 'save_ha_config',
	haConfigStatus: 'ha_config_status',
	haTestConnection: 'ha_test_connection',
	// MQTT source (mqtt.rs)
	saveMqttConfig: 'save_mqtt_config',
	mqttConfigStatus: 'mqtt_config_status',
	mqttConnect: 'mqtt_connect',
	mqttDisconnect: 'mqtt_disconnect',
	mqttCatalog: 'mqtt_catalog',
	// stocks source (stocks.rs)
	saveStocksConfig: 'save_stocks_config',
	stocksConfigStatus: 'stocks_config_status',
	stocksConnect: 'stocks_connect',
	stocksDisconnect: 'stocks_disconnect',
	// weather source (weather.rs)
	saveWeatherConfig: 'save_weather_config',
	weatherConfigStatus: 'weather_config_status',
	weatherConnect: 'weather_connect',
	weatherDisconnect: 'weather_disconnect',
	// RSS source (rss.rs)
	saveRssConfig: 'save_rss_config',
	rssConfigStatus: 'rss_config_status',
	rssConnect: 'rss_connect',
	rssDisconnect: 'rss_disconnect',
	// Agenda / ICS source (agenda.rs)
	saveAgendaConfig: 'save_agenda_config',
	agendaConfigStatus: 'agenda_config_status',
	agendaConnect: 'agenda_connect',
	agendaDisconnect: 'agenda_disconnect',
	// AI provider + agent control (llm.rs, control.rs)
	saveLlmConfig: 'save_llm_config',
	llmConfigStatus: 'llm_config_status',
	llmTestConnection: 'llm_test_connection',
	llmComplete: 'llm_complete',
	llmListModels: 'llm_list_models',
	llmStream: 'llm_stream',
	llmCancel: 'llm_cancel',
	llmTranscribe: 'llm_transcribe',
	llmSynthesize: 'llm_synthesize',
	controlStart: 'control_start',
	controlStop: 'control_stop',
	// Launch at login. These wrap tauri-plugin-autostart but go through our own commands
	// (autostart.rs) so a durable preference is written alongside the OS Run key — the Run key
	// alone doesn't survive a manual install (the NSIS uninstaller wipes it).
	autostartGet: 'get_autostart_enabled',
	autostartSet: 'set_autostart_enabled'
} as const;
