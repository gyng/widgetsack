#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use listener::{session_listener_windows_gsmtc, ManagerEventWrapper, SessionUpdateEventWrapper};
use state::SessionRecord;
use std::collections::HashMap;
use tauri::async_runtime::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tokio::sync::mpsc;

use crate::command::get_initial_sessions;
use crate::event::emit_to_bridge;
use crate::state::updater;

pub mod audio;
pub mod bridge;
pub mod clickthrough;
pub mod command;
pub mod control;
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
pub mod sensors;
pub mod stocks;
pub mod state;
pub mod timings;
pub mod weather;
pub mod windowmgr;

pub struct AppState {
    pub sessions: Mutex<HashMap<usize, SessionRecord>>,
}

/// Open the studio window, or focus it if already open. Normally the primary `main` overlay's JS owns
/// studio construction (it listens for `open_studio`) — but `main` is DESTROYED to reclaim its renderer
/// when the primary monitor is empty (overlay.ts `setMainWindowVisible` / command.rs `watch_layout`),
/// and a dead window can't host that listener. So when `main` is absent we build the studio directly
/// here, mirroring overlay.ts `openStudio`, keeping the tray "Open designer", the tray left-click, and
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

    tauri::Builder::default()
        // Single-instance MUST be the first plugin (its callback fires synchronously on a second
        // launch, before windows exist). A second launch focuses the running app by emitting
        // open_studio (the primary overlay opens the studio), then that process exits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            open_or_focus_studio(app);
        }))
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
        .manage(clickthrough::InteractiveRects::default())
        .manage(control::ControlState::default())
        .manage(ha::HaState::default())
        .manage(llm::LlmState::default())
        .manage(mqtt::MqttState::default())
        .manage(stocks::StocksState::default())
        .manage(weather::WeatherState::default())
        .manage(timings::SubsystemTimings::default())
        .manage(sensors::ActiveSensors::default())
        .manage(audio::SpectrumState::default())
        .manage(process_diag::ProcDiag::default())
        .invoke_handler(tauri::generate_handler![
            get_initial_sessions,
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
            command::system_fonts,
            display::list_display_names,
            clickthrough::set_interactive_rects,
            clickthrough::current_work_area,
            clickthrough::set_overlay_wallpaper,
            sensors::set_active_sensors,
            audio::start_spectrum,
            audio::stop_spectrum,
            audio::list_audio_outputs,
            audio::default_audio_output,
            audio::set_default_audio_output,
            media::media_control,
            media::media_capabilities,
            log::get_logs,
            ha::ha_connect,
            ha::ha_disconnect,
            ha::list_ha_entities,
            ha::ha_registry_snapshot,
            ha::ha_call_service,
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
            process_diag::process_diagnostics
        ])
        .setup(|app| {
            // Wire structured logging to the app so records also stream to the webview (`log` event).
            log::init(app.handle().clone());

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
                        emit_to_bridge(&app_handle.clone(), delta);
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

            // Tray menu: the only reliable way to toggle edit mode while the overlay
            // is click-through (a passive window receives no in-app keys).
            let edit_item = MenuItemBuilder::with_id("edit", "Edit layout").build(app)?;
            let designer_item = MenuItemBuilder::with_id("designer", "Open designer").build(app)?;
            // Snap every open window that matches a zone widget's rule into that zone (overlays handle it).
            let arrange_item = MenuItemBuilder::with_id("arrange", "Arrange windows").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&edit_item)
                .item(&designer_item)
                .item(&arrange_item)
                .item(&quit_item)
                .build()?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Widget overlay — right-click for menu")
                .menu(&tray_menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "edit" => {
                        let _ = app.emit(bridge::TOGGLE_EDIT_EVENT, ());
                    }
                    "designer" => {
                        // Opens (or focuses) the studio. Falls back to building it directly when the
                        // primary overlay (`main`) was reclaimed and can't host the open_studio listener.
                        open_or_focus_studio(app);
                    }
                    "arrange" => {
                        // Each overlay snaps the windows matching ITS monitor's zone rules.
                        let _ = app.emit(bridge::ARRANGE_ZONES_EVENT, ());
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
