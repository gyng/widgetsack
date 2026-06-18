//! Media transport control + capabilities for the now-playing widget. The GSMTC listener
//! (listener.rs) is read-only — it hands back metadata, not a controllable session — so playback
//! control and the per-session "which controls are enabled" flags go straight to the Windows
//! GlobalSystemMediaTransportControlsSessionManager here. Windows-only.

use serde::Serialize;

/// Which transport controls the matched session supports (mirrors the JS `MediaCaps` type in
/// client/src/lib/components/NowPlaying/source.ts — keep both sides in sync, AGENTS.md §5).
/// All-false when there is no active session.
#[derive(Default, Serialize)]
pub struct MediaCaps {
    pub play: bool,
    pub pause: bool,
    pub playpause: bool,
    pub stop: bool,
    pub next: bool,
    pub previous: bool,
    pub shuffle: bool,
    pub repeat: bool,
    pub seek: bool,
}

/// Frontend → backend: actuate a media session. `action` is one of
/// `playpause` | `play` | `pause` | `stop` | `next` | `previous` | `shuffle` | `repeat` | `seek`.
/// `value` carries the argument for the stateful actions: `shuffle` (0 = off, non-0 = on),
/// `repeat` (0 = none, 1 = track, 2 = list), `seek` (target position in SECONDS). `source`
/// (optional) is the widget's session source (GSMTC SourceAppUserModelId); when it matches a live
/// session that one is controlled, otherwise the system "current" session is used.
#[tauri::command]
pub async fn media_control(
    action: String,
    source: Option<String>,
    value: Option<f64>,
) -> Result<(), String> {
    control(action, source, value).await
}

/// Frontend → backend: which transport controls the matched (or current) session supports, so the
/// widget can hide buttons a player doesn't expose. Returns all-false when there is no session.
#[tauri::command]
pub async fn media_capabilities(source: Option<String>) -> Result<Option<MediaCaps>, String> {
    capabilities(source).await
}

#[cfg(target_os = "windows")]
async fn control(action: String, source: Option<String>, value: Option<f64>) -> Result<(), String> {
    // The WinRT calls block (via `.get()`) and need a COM apartment, so run them on a blocking
    // thread we initialize as MTA — the tokio runtime threads aren't COM-initialized.
    tokio::task::spawn_blocking(move || control_blocking(&action, source.as_deref(), value))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "windows")]
async fn capabilities(source: Option<String>) -> Result<Option<MediaCaps>, String> {
    tokio::task::spawn_blocking(move || caps_blocking(source.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "windows")]
fn control_blocking(action: &str, source: Option<&str>, value: Option<f64>) -> Result<(), String> {
    use windows::Media::MediaPlaybackAutoRepeatMode;

    let session = resolve_session(source)?.ok_or_else(|| "no active media session".to_string())?;

    let op = match action {
        "playpause" => session.TryTogglePlayPauseAsync(),
        "play" => session.TryPlayAsync(),
        "pause" => session.TryPauseAsync(),
        "stop" => session.TryStopAsync(),
        "next" => session.TrySkipNextAsync(),
        "previous" | "prev" => session.TrySkipPreviousAsync(),
        "shuffle" => session.TryChangeShuffleActiveAsync(value.unwrap_or(0.0) != 0.0),
        "repeat" => {
            let mode = match value.unwrap_or(0.0) as i64 {
                v if v >= 2 => MediaPlaybackAutoRepeatMode::List,
                1 => MediaPlaybackAutoRepeatMode::Track,
                _ => MediaPlaybackAutoRepeatMode::None,
            };
            session.TryChangeAutoRepeatModeAsync(mode)
        }
        // GSMTC playback position is in 100-ns ticks; the frontend sends seconds.
        "seek" => {
            let ticks = (value.unwrap_or(0.0) * 10_000_000.0) as i64;
            session.TryChangePlaybackPositionAsync(ticks)
        }
        other => return Err(format!("unknown media action: {other}")),
    }
    .map_err(|e| e.to_string())?;

    // The Try* op resolves to a bool (false = the session declined the request); a decline is
    // not an error to surface — treat it as best-effort.
    op.get().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn caps_blocking(source: Option<&str>) -> Result<Option<MediaCaps>, String> {
    // No session → None (not all-false), so the widget shows every button rather than hiding the
    // basics on a transient gap. Real flags only gate buttons when a session actually reports them.
    let session = match resolve_session(source)? {
        Some(s) => s,
        None => return Ok(None),
    };
    let info = session.GetPlaybackInfo().map_err(|e| e.to_string())?;
    let c = info.Controls().map_err(|e| e.to_string())?;
    // A flag we can't read is treated as "not supported" rather than failing the whole query.
    let g = |r: windows::core::Result<bool>| r.unwrap_or(false);
    let play = g(c.IsPlayEnabled());
    let pause = g(c.IsPauseEnabled());
    Ok(Some(MediaCaps {
        play,
        pause,
        // Some players only flag play/pause individually, not the toggle — accept either.
        playpause: g(c.IsPlayPauseToggleEnabled()) || play || pause,
        stop: g(c.IsStopEnabled()),
        next: g(c.IsNextEnabled()),
        previous: g(c.IsPreviousEnabled()),
        shuffle: g(c.IsShuffleEnabled()),
        repeat: g(c.IsRepeatEnabled()),
        seek: g(c.IsPlaybackPositionEnabled()),
    }))
}

/// The session whose SourceAppUserModelId matches `source`, else the system "current" session.
/// Initializes COM (MTA) on the calling (blocking) thread first — required for the WinRT calls.
#[cfg(target_os = "windows")]
fn resolve_session(
    source: Option<&str>,
) -> Result<Option<windows::Media::Control::GlobalSystemMediaTransportControlsSession>, String> {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager as Manager;
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};

    // Best-effort: S_OK / S_FALSE (already inited) / RPC_E_CHANGED_MODE are all fine to ignore.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let manager = Manager::RequestAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;

    Ok(source
        .and_then(|src| session_for_source(&manager, src))
        .or_else(|| manager.GetCurrentSession().ok()))
}

/// Find the live session whose SourceAppUserModelId matches `source` (the widget's session
/// source). Returns None on any enumeration failure so the caller falls back to the current session.
#[cfg(target_os = "windows")]
fn session_for_source(
    manager: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager,
    source: &str,
) -> Option<windows::Media::Control::GlobalSystemMediaTransportControlsSession> {
    let sessions = manager.GetSessions().ok()?;
    let count = sessions.Size().ok()?;
    for i in 0..count {
        let session = sessions.GetAt(i).ok()?;
        if session
            .SourceAppUserModelId()
            .map(|id| id.to_string())
            .ok()
            .as_deref()
            == Some(source)
        {
            return Some(session);
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
async fn control(
    _action: String,
    _source: Option<String>,
    _value: Option<f64>,
) -> Result<(), String> {
    Err("media control is only available on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
async fn capabilities(_source: Option<String>) -> Result<Option<MediaCaps>, String> {
    Err("media control is only available on Windows".to_string())
}
