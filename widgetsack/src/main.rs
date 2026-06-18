#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use listener::{ManagerEventWrapper, SessionUpdateEventWrapper, session_listener_windows_gsmtc};
use state::SessionRecord;
use std::collections::HashMap;
use tauri::async_runtime::Mutex;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tokio::sync::mpsc;

use crate::command::get_initial_sessions;
use crate::event::emit_to_bridge;
use crate::state::updater;

pub mod agenda;
pub mod art;
pub mod audio;
pub mod autostart;
pub mod bridge;
pub mod clickthrough;
pub mod command;
pub mod control;
pub mod ddc;
pub mod display;
pub mod event;
pub mod ha;
pub mod listener;
pub mod llm;
pub mod log;
pub mod media;
pub mod mqtt;
pub mod netconn;
pub mod ping;
pub mod process_diag;
pub mod recyclebin;
pub mod rss;
pub mod sensors;
pub mod state;
pub mod stocks;
pub mod timings;
pub mod weather;
pub mod wifi;
pub mod windowmgr;

pub struct AppState {
    pub sessions: Mutex<HashMap<usize, SessionRecord>>,
}

/// Open the studio window, or focus it if already open. Normally the primary `main` overlay's JS owns
/// studio construction (it listens for `open_studio`) — but `main` is DESTROYED to reclaim its renderer
/// when the primary monitor is empty (overlay.ts `setMainWindowVisible` / command.rs `watch_layout`),
/// and a dead window can't host that listener. So when `main` is absent we build the studio directly
/// here, mirroring overlay.ts `openStudio`, keeping the tray "Open studio", the tray left-click, and
/// the single-instance second-launch working even with no primary overlay present. Runs on the main
/// thread (its callers are tray/single-instance handlers on the event loop).
fn open_or_focus_studio(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("studio") {
        let _ = w.set_focus();
        return;
    }
    if app.get_webview_window("main").is_some() {
        // `main` is alive — keep a single source of truth for the studio window config: let its JS
        // build the studio (unchanged path) by emitting the event it listens for.
        let _ = app.emit(bridge::OPEN_STUDIO_EVENT, ());
        return;
    }
    build_studio_window(app);
}

/// Build the studio webview window directly (mirrors overlay.ts `openStudio`). Split out of
/// `open_or_focus_studio` so the `--studio` startup launch can build it WITHOUT going through the
/// main overlay's JS — at boot that webview hasn't registered the `open_studio` listener yet.
fn build_studio_window(app: &tauri::AppHandle) {
    if app.get_webview_window("studio").is_some() {
        return;
    }
    if let Err(err) =
        tauri::WebviewWindowBuilder::new(app, "studio", tauri::WebviewUrl::App("/".into()))
            .title("WidgetSack Studio")
            .inner_size(980.0, 680.0)
            .resizable(true)
            .decorations(false)
            .disable_drag_drop_handler()
            .build()
    {
        log::warn("studio", "failed to open studio window from backend")
            .field("error", err)
            .emit();
    }
}

/// Whether this process was launched to open the designer. The Start Menu / desktop shortcuts and the
/// installer's "Run WidgetSack" checkbox pass `--studio`, so starting the app manually shows the
/// studio window instead of just the silent (and, on a fresh install, empty) overlay. Autostart at
/// login passes no flag and stays silent.
fn launched_with_studio_flag() -> bool {
    std::env::args().any(|arg| arg == "--studio")
}

/// Whether this process should run as an independent EXTRA instance — typically a dev/debug build run
/// alongside the installed release. When set, the single-instance lock is skipped (so this process
/// doesn't just focus the already-running one and exit) AND the config dir is isolated to a `multi/`
/// subfolder (see `command::config_root`), so it never clobbers the release's widgets.json / themes /
/// layouts. Enabled by the `--multi` flag or `WIDGETSACK_MULTI=1`. Memoized — args/env are fixed for
/// the process lifetime.
pub fn multi_instance() -> bool {
    use std::sync::OnceLock;
    static MULTI: OnceLock<bool> = OnceLock::new();
    *MULTI.get_or_init(|| {
        std::env::args().any(|arg| arg == "--multi")
            || std::env::var("WIDGETSACK_MULTI")
                .map(|v| !v.is_empty() && v != "0")
                .unwrap_or(false)
    })
}

/// Whether this is a dev / extra instance — launched with `--multi` (run alongside the installed
/// release) or built in debug. The studio shows a small "dev" badge by the window controls so it's
/// distinguishable from the real release at a glance.
#[tauri::command]
fn is_dev_instance() -> bool {
    multi_instance() || cfg!(debug_assertions)
}

/// The window-state the app persists across runs: size / position / maximized / fullscreen, but NOT
/// decorations or visibility (config + the frontend own those — see the plugin registration). Shared
/// by the plugin (what it saves + restores) AND the studio-close flush below, so both agree.
fn window_state_flags() -> tauri_plugin_window_state::StateFlags {
    tauri_plugin_window_state::StateFlags::all()
        & !tauri_plugin_window_state::StateFlags::DECORATIONS
        & !tauri_plugin_window_state::StateFlags::VISIBLE
}

#[tokio::main]
async fn main() -> Result<(), ()> {
    // Route panics through the logging pipeline (stderr + rotating file + webview) so a panic on
    // any thread is never silent. Installed before anything else, so even a panic during startup
    // (before `log::init` wires the app handle) still hits stderr + the file.
    std::panic::set_hook(Box::new(log::log_panic));

    let rx_session_manager = gsmtc::SessionManager::create()
        .await
        .expect("{failed to create gsmtc::SessionManager");
    // Capacity 16 (was 1): a burst of media events (e.g. a track change firing several
    // SessionUpdateEvents) can't briefly block the gsmtc listener task on a full channel.
    let (tx_gsmtc, mut rx_gsmtc) = mpsc::channel(16);

    // Single-instance MUST be the first plugin (its callback fires synchronously on a second
    // launch, before windows exist). A second launch focuses the running app by emitting
    // open_studio (the primary overlay opens the studio), then that process exits. SKIPPED for an
    // extra dev instance (`--multi` / WIDGETSACK_MULTI), so it can run alongside the installed
    // release instead of just focusing it — see `multi_instance`.
    let builder = tauri::Builder::default();
    let builder = if multi_instance() {
        eprintln!(
            "[widgetsack] multi-instance: single-instance lock skipped; config isolated to <app config>/multi"
        );
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            open_or_focus_studio(app);
        }))
    };
    builder
        // "Launch at login" support. The Settings toggle enables/disables it via the granted
        // autostart:* commands (overlay.json capability); registering it here just makes them work.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        // Persist window size/position, but DO NOT let the plugin manage DECORATIONS or VISIBLE:
        // - DECORATIONS: our overlays are intentionally borderless (config `decorations:false`),
        //   and the default `StateFlags::all()` would restore a stale saved `decorations:true` at
        //   startup — re-adding a title bar/border that our JS never counters (it only re-asserts
        //   shadow).
        // - VISIBLE: the main window is born hidden (config `visible:false`) and only revealed by
        //   the frontend AFTER it has been sized/positioned to fill the primary monitor and the
        //   layout has rendered (overlay.ts `setMainWindowVisible` via `syncPrimaryOverlays`).
        //   Restoring the saved `visible:true` here would un-hide it at its stale boot geometry,
        //   reintroducing the startup flash of mis-placed/blank content this is meant to prevent.
        // Excluding both flags makes config + JS the single source of truth for them.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(window_state_flags())
                // Don't persist/restore the "main" window's geometry: it is ALWAYS re-filled to
                // the primary monitor at startup (overlay.ts `fillPrimaryMonitor`), so restoring
                // stale saved geometry is pointless and risks a startup flash at the wrong spot.
                // A denylisted window is skipped entirely (no restore AND no save). "studio" still
                // persists (remembering a normal window's size/pos is the point), and dynamic
                // "overlay-N" windows re-assert exact geometry in their created handler. On restore
                // the plugin only re-applies a saved POSITION if it still intersects a CONNECTED
                // monitor (else it lets the OS place the window), so the studio never reopens
                // off-screen on a since-disconnected display.
                .with_denylist(&["main"])
                .build(),
        )
        // The window-state plugin only flushes geometry to disk on a clean RunEvent::Exit. An app
        // UPGRADE that force-kills the process (installer / taskkill) would otherwise lose the studio's
        // latest size + position, so flush to disk the moment the studio window closes — its live
        // moves/resizes are already in the plugin's cache. Studio only: overlays + main re-assert exact
        // geometry on launch, so eagerly persisting theirs isn't worth the disk churn.
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == "studio" {
                use tauri_plugin_window_state::AppHandleExt;
                let _ = window.app_handle().save_window_state(window_state_flags());
            }
        })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            sessions: Default::default(),
        })
        // Album-art store: covers are served to the webview over the `art` URI scheme (below)
        // instead of being shipped as JSON byte arrays. See art.rs.
        .manage(art::ArtState::default())
        .manage(clickthrough::InteractiveRects::default())
        .manage(control::ControlState::default())
        .manage(ha::HaState::default())
        .manage(llm::LlmState::default())
        .manage(mqtt::MqttState::default())
        .manage(stocks::StocksState::default())
        .manage(weather::WeatherState::default())
        .manage(rss::RssState::default())
        .manage(agenda::AgendaState::default())
        .manage(timings::SubsystemTimings::default())
        .manage(sensors::ActiveSensors::default())
        .manage(audio::SpectrumState::default())
        .manage(process_diag::ProcDiag::default())
        // Serve album art from memory over `art` (Windows/WebView2: http://art.localhost/<hash>).
        // Available to every webview (all overlays + the studio); keep the CSP `img-src` token in
        // tauri.conf.json in sync. The closure just forwards to the tested handler in art.rs.
        .register_uri_scheme_protocol("art", |ctx, request| art::serve_art(ctx, request))
        .invoke_handler(tauri::generate_handler![
            get_initial_sessions,
            is_dev_instance,
            command::load_layout,
            command::save_layout,
            command::load_controls,
            command::save_controls,
            windowmgr::list_windows,
            windowmgr::snap_window,
            windowmgr::pointer_probe,
            command::list_themes,
            command::load_theme,
            command::save_theme,
            command::delete_theme,
            command::list_wallpapers,
            command::wallpaper_path,
            command::open_wallpapers_dir,
            command::list_sacks,
            command::read_sack,
            command::write_sack,
            command::list_plugin_packages,
            command::read_plugin_package_asset,
            command::install_plugin_package,
            command::check_plugin_package_update,
            command::remove_plugin_package,
            command::package_fetch,
            command::list_layouts,
            command::read_layout,
            command::save_layout_as,
            command::delete_layout,
            command::open_devtools,
            command::list_window_labels,
            command::open_devtools_for,
            command::set_window_interactive,
            command::rescue_windows,
            command::reload_window,
            command::log_diag,
            command::check_app_update,
            command::system_fonts,
            display::list_display_names,
            ddc::list_monitor_inputs,
            ddc::set_monitor_input,
            clickthrough::set_interactive_rects,
            clickthrough::current_work_area,
            clickthrough::set_overlay_wallpaper,
            sensors::set_active_sensors,
            audio::start_spectrum,
            audio::stop_spectrum,
            audio::list_audio_outputs,
            audio::default_audio_output,
            audio::set_default_audio_output,
            audio::get_audio_volume,
            audio::set_audio_volume,
            audio::set_audio_mute,
            media::media_control,
            media::media_capabilities,
            log::get_logs,
            ha::ha_connect,
            ha::ha_disconnect,
            ha::list_ha_entities,
            ha::ha_registry_snapshot,
            ha::ha_call_service,
            ha::ha_history,
            ha::ha_media_art,
            ha::save_ha_config,
            ha::ha_config_status,
            ha::ha_test_connection,
            mqtt::save_mqtt_config,
            mqtt::mqtt_config_status,
            mqtt::mqtt_connect,
            mqtt::mqtt_disconnect,
            mqtt::mqtt_catalog,
            stocks::save_stocks_config,
            stocks::stocks_config_status,
            stocks::stocks_connect,
            stocks::stocks_disconnect,
            weather::save_weather_config,
            weather::weather_config_status,
            weather::weather_connect,
            weather::weather_disconnect,
            rss::save_rss_config,
            rss::rss_config_status,
            rss::rss_connect,
            rss::rss_disconnect,
            agenda::save_agenda_config,
            agenda::agenda_config_status,
            agenda::agenda_connect,
            agenda::agenda_disconnect,
            timings::set_subsystem_profiling,
            timings::subsystem_timings,
            llm::save_llm_config,
            llm::llm_config_status,
            llm::llm_test_connection,
            llm::llm_complete,
            llm::llm_list_models,
            llm::llm_stream,
            llm::llm_cancel,
            llm::llm_transcribe,
            llm::llm_synthesize,
            control::control_start,
            control::control_stop,
            process_diag::process_diagnostics,
            autostart::get_autostart_enabled,
            autostart::set_autostart_enabled
        ])
        .setup(|app| {
            // Wire structured logging to the app so records also stream to the webview (`log` event).
            log::init(app.handle().clone());

            // Re-assert "launch at login" from the durable preference. The NSIS uninstaller wipes
            // the OS Run key on every manual upgrade, so this is what makes the setting survive an
            // install (autostart.rs).
            autostart::reconcile(app.handle());

            // `--studio` (shortcuts + installer "Run") opens the designer on a manual launch, so the
            // app shows a window instead of just the silent overlay. Built directly here because the
            // overlay webview isn't ready to receive `open_studio` yet at boot.
            if launched_with_studio_flag() {
                build_studio_window(app.handle());
            }

            tauri::async_runtime::spawn(async move {
                session_listener_windows_gsmtc(rx_session_manager, tx_gsmtc).await
            });

            let app_handle = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                loop {
                    if let Some(event) = rx_gsmtc.recv().await {
                        let state: State<AppState> = app_handle.state();
                        let mut sessions = state.sessions.lock().await;
                        let delta = updater(&mut sessions, event);
                        // Register the cover BEFORE emitting so the webview's immediate fetch of the
                        // serialized `url` finds the bytes (art.rs); a media update is the only delta
                        // that carries one.
                        if let Some(record) = &delta.1 {
                            art::register_cover(&app_handle, record);
                        }
                        emit_to_bridge(&app_handle, delta);
                    }
                }
            });

            let sensors_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sensors::run_system_sensors(sensors_handle).await;
            });

            // Ping / "is my internet up?" poller — always running, but demand-gated: it pings only the
            // hosts named by mounted net.ping.* sensors, so it's free until a Ping widget is placed.
            let ping_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                ping::run_ping_source(ping_handle).await;
            });

            // Agent-control server: OPT-IN (off unless LlmConfig.agent_control is true). Started on
            // demand so a fresh install never opens a port.
            let control_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = control_handle.state::<control::ControlState>();
                control::start_if_enabled(control_handle.clone(), &state).await;
            });

            if let Err(err) = command::watch_layout(app.handle().clone()) {
                log::error("startup", "failed to start layout watcher")
                    .field("error", err)
                    .emit();
            }

            // Control remaps (controls.json): live-reload on external edits / cross-window saves.
            if let Err(err) = command::watch_controls(app.handle().clone()) {
                log::error("startup", "failed to start controls watcher")
                    .field("error", err)
                    .emit();
            }

            // Themes (Phase 7c): seed example themes on first run + watch the folder.
            command::seed_themes(&app.handle().clone());
            if let Err(err) = command::watch_themes(app.handle().clone()) {
                log::error("startup", "failed to start themes watcher")
                    .field("error", err)
                    .emit();
            }

            clickthrough::run_clickthrough_watcher(app.handle().clone());

            // Live drag-to-zone (MVP2): a SetWinEventHook message-pump thread emitting
            // win_drag_start / win_drag_end; the overlay highlights + snaps. Own thread (the
            // clickthrough watcher has no message pump). No-op off Windows.
            windowmgr::run_drag_watcher(app.handle().clone());

            // Tray menu (right-click): open the studio, the two overlay utilities, a launch-at-login
            // toggle, then Quit (separated). Edit mode is NOT here — it lives on Ctrl+E and the global
            // hotkey; a tray toggle for it read as confusing chrome.
            let designer_item = MenuItemBuilder::with_id("designer", "Open studio").build(app)?;
            // Snap every open window that matches a zone widget's rule into that zone (overlays handle it).
            let arrange_item = MenuItemBuilder::with_id("arrange", "Arrange windows").build(app)?;
            // Re-fit overlays to the current display layout — for when monitors are moved/added/removed
            // at runtime (no per-window scale-change event fires for that, so overlays go stale).
            let refit_item =
                MenuItemBuilder::with_id("refit", "Re-fit overlays to displays").build(app)?;
            // "Start at login" — a check item mirroring the Settings toggle (the durable HKCU pref). Read
            // the current state for the initial check; the handler flips it via the same autostart path.
            let autostart_on =
                autostart::get_autostart_enabled(app.handle().clone()).unwrap_or(false);
            let autostart_item = CheckMenuItemBuilder::with_id("autostart", "Start at login")
                .checked(autostart_on)
                .build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&designer_item)
                .item(&arrange_item)
                .item(&refit_item)
                .item(&autostart_item)
                .separator()
                .item(&quit_item)
                .build()?;
            // Mark a dev / extra instance in the tooltip too (matches the studio "dev" badge), so a
            // --multi / debug instance is identifiable from the tray.
            let dev_suffix = if is_dev_instance() { " (dev)" } else { "" };
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip(format!(
                    "widgetsack v{}{}: click to open studio",
                    app.package_info().version,
                    dev_suffix
                ))
                .menu(&tray_menu)
                // The menu is RIGHT-click only; left-click opens the studio (on_tray_icon_event below).
                // Tauri's default ALSO pops the menu on left-click, so a left-click would do both — off.
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "designer" => {
                        // Opens (or focuses) the studio. Falls back to building it directly when the
                        // primary overlay (`main`) was reclaimed and can't host the open_studio listener.
                        open_or_focus_studio(app);
                    }
                    "arrange" => {
                        // Each overlay snaps the windows matching ITS monitor's zone rules.
                        let _ = app.emit(bridge::ARRANGE_ZONES_EVENT, ());
                    }
                    "refit" => {
                        // Re-fit every overlay to the CURRENT display layout (monitors moved/added/removed).
                        let _ = app.emit(bridge::REFIT_OVERLAYS_EVENT, ());
                    }
                    "autostart" => {
                        // Flip launch-at-login via the same durable-pref path as Settings, then reflect the
                        // applied state on the check item (clicking a check item doesn't auto-toggle it).
                        let now = autostart::get_autostart_enabled(app.clone()).unwrap_or(false);
                        let applied =
                            autostart::set_autostart_enabled(app.clone(), !now).unwrap_or(now);
                        let _ = autostart_item.set_checked(applied);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                // Left-click (primary button release) opens the designer; right-click still shows
                // the menu above. Match on the button-up edge so a single click fires once.
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        open_or_focus_studio(tray.app_handle());
                    }
                })
                .build(app)?;

            // Global hotkey: toggle edit mode from anywhere (a passive click-through
            // overlay receives no in-app keys). Broadcasts the same event the tray and
            // Ctrl+E use, so every monitor's overlay toggles together.
            let toggle_edit_shortcut =
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyE);
            if let Err(err) =
                app.global_shortcut()
                    .on_shortcut(toggle_edit_shortcut, |app, _shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            let _ = app.emit(bridge::TOGGLE_EDIT_EVENT, ());
                        }
                    })
            {
                log::error("startup", "failed to register global shortcut")
                    .field("error", err)
                    .emit();
            }

            // Rescue hotkey (Ctrl+Alt+Shift+E): make EVERY window interactive again and bring it
            // forward. The backend "panic button" for an overlay you can't reach — a click-through
            // window, or one whose webview crashed so its own JS can no longer drop click-through.
            // Handled entirely in Rust, so it works even when the target window's JS is dead.
            let rescue_shortcut = Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
                Code::KeyE,
            );
            if let Err(err) =
                app.global_shortcut()
                    .on_shortcut(rescue_shortcut, |app, _shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            command::rescue_all(app);
                        }
                    })
            {
                log::error("startup", "failed to register rescue shortcut")
                    .field("error", err)
                    .emit();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    Ok(())
}
