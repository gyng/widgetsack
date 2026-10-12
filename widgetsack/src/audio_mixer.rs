//! Core Audio session mixer and default communications microphone control.
use serde::Serialize;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSession {
    id: String,
    name: String,
    level: f32,
    muted: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MixerSnapshot {
    sessions: Vec<AudioSession>,
    microphone: Option<crate::audio::AudioVolume>,
    session_error: Option<String>,
}

fn mixer_snapshot(
    sessions: Result<Vec<AudioSession>, String>,
    microphone: Option<crate::audio::AudioVolume>,
) -> MixerSnapshot {
    let (mut sessions, session_error) = match sessions {
        Ok(sessions) => (sessions, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    sessions.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    MixerSnapshot {
        sessions,
        microphone,
        session_error,
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use windows::{
        Win32::{
            Media::Audio::{
                AudioSessionStateExpired, Endpoints::IAudioEndpointVolume, IAudioSessionControl2,
                IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
                eCapture, eCommunications, eConsole, eRender,
            },
            System::Com::{CLSCTX_ALL, CoCreateInstance, CoTaskMemFree},
        },
        core::Interface,
    };
    unsafe fn take_string(p: windows::core::PWSTR) -> String {
        // SAFETY: Core Audio returns a COM-allocated null-terminated string; copy then free once.
        unsafe {
            let value = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0.cast()));
            value
        }
    }
    fn enumerator() -> windows::core::Result<IMMDeviceEnumerator> {
        crate::audio::ensure_com_mta();
        // SAFETY: all COM interfaces stay on the initialized blocking thread.
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
    }
    fn sessions() -> windows::core::Result<Vec<(IAudioSessionControl2, ISimpleAudioVolume)>> {
        // SAFETY: documented Core Audio activation/casts; interfaces drop on this thread.
        unsafe {
            let device = enumerator()?.GetDefaultAudioEndpoint(eRender, eConsole)?;
            let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
            let list = manager.GetSessionEnumerator()?;
            let mut result = Vec::new();
            for i in 0..list.GetCount()? {
                // Sessions can disappear during enumeration; preserve the remaining apps.
                let Ok(control) = list.GetSession(i) else {
                    continue;
                };
                let Ok(state) = control.GetState() else {
                    continue;
                };
                if state == AudioSessionStateExpired {
                    continue;
                }
                if let (Ok(control), Ok(volume)) = (control.cast(), control.cast()) {
                    result.push((control, volume));
                }
            }
            Ok(result)
        }
    }
    fn mic() -> windows::core::Result<IAudioEndpointVolume> {
        // SAFETY: standard default capture endpoint activation.
        unsafe {
            enumerator()?
                .GetDefaultAudioEndpoint(eCapture, eCommunications)?
                .Activate(CLSCTX_ALL, None)
        }
    }
    pub fn read() -> MixerSnapshot {
        // SAFETY: reads on the COM worker; strings are copied and freed before returning plain data.
        unsafe {
            let names = crate::netconn::process_names();
            let session_result = sessions().map_err(|e| e.to_string()).map(|sessions| {
                sessions
                    .into_iter()
                    .filter_map(|(control, volume)| read_session(&control, &volume, &names).ok())
                    .collect()
            });
            let microphone = mic().ok().and_then(|v| {
                Some(crate::audio::AudioVolume {
                    level: v.GetMasterVolumeLevelScalar().ok()?,
                    muted: v.GetMute().ok()?.as_bool(),
                })
            });
            mixer_snapshot(session_result, microphone)
        }
    }
    fn read_session(
        control: &IAudioSessionControl2,
        volume: &ISimpleAudioVolume,
        names: &std::collections::HashMap<u32, String>,
    ) -> windows::core::Result<AudioSession> {
        // SAFETY: reads an enumerated session on its owning COM thread; allocated strings are freed.
        unsafe {
            let id = take_string(control.GetSessionInstanceIdentifier()?);
            let pid = control.GetProcessId().unwrap_or(0);
            let display = control
                .GetDisplayName()
                .map(|p| take_string(p))
                .unwrap_or_default();
            let name = names.get(&pid).cloned().unwrap_or_else(|| {
                if !display.is_empty() {
                    display
                } else if pid == 0 {
                    "System sounds".into()
                } else {
                    format!("Process {pid}")
                }
            });
            Ok(AudioSession {
                id,
                name,
                level: volume.GetMasterVolume()?,
                muted: volume.GetMute()?.as_bool(),
            })
        }
    }
    pub fn write(id: String, level: Option<f32>, muted: Option<bool>) -> Result<(), String> {
        if level.is_some_and(|l| !l.is_finite()) {
            return Err("Volume must be finite".into());
        }
        // SAFETY: fresh enumeration avoids reusing COM interfaces or stale session pointers.
        unsafe {
            for (control, volume) in sessions().map_err(|e| e.to_string())? {
                let Ok(identifier) = control.GetSessionInstanceIdentifier() else {
                    continue;
                };
                if take_string(identifier) == id {
                    if let Some(l) = level {
                        volume
                            .SetMasterVolume(l.clamp(0.0, 1.0), std::ptr::null())
                            .map_err(|e| e.to_string())?;
                    }
                    if let Some(m) = muted {
                        volume
                            .SetMute(m, std::ptr::null())
                            .map_err(|e| e.to_string())?;
                    }
                    return Ok(());
                }
            }
        }
        Err("Audio session has ended".into())
    }
    pub fn mute_microphone(muted: bool) -> Result<(), String> {
        // SAFETY: writes only the default communications capture endpoint's mute flag.
        unsafe {
            mic()
                .map_err(|e| e.to_string())?
                .SetMute(muted, std::ptr::null())
                .map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
pub async fn get_audio_mixer() -> Result<MixerSnapshot, String> {
    #[cfg(target_os = "windows")]
    {
        crate::audio::com_call(
            "get_audio_mixer",
            std::time::Duration::from_secs(2),
            platform::read,
        )
        .await
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Audio mixer requires Windows".into())
    }
}
#[tauri::command]
pub async fn set_audio_session(
    id: String,
    level: Option<f32>,
    muted: Option<bool>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        crate::audio::com_call(
            "set_audio_session",
            std::time::Duration::from_secs(2),
            move || platform::write(id, level, muted),
        )
        .await?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (id, level, muted);
        Err("Audio mixer requires Windows".into())
    }
}
#[tauri::command]
pub async fn set_microphone_mute(muted: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        crate::audio::com_call(
            "set_microphone_mute",
            std::time::Duration::from_secs(2),
            move || platform::mute_microphone(muted),
        )
        .await?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = muted;
        Err("Microphone control requires Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_contract() {
        let value = serde_json::to_value(MixerSnapshot {
            sessions: vec![AudioSession {
                id: "session".into(),
                name: "App".into(),
                level: 0.5,
                muted: false,
            }],
            microphone: None,
            session_error: None,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "sessions": [{ "id": "session", "name": "App", "level": 0.5, "muted": false }], "microphone": null, "sessionError": null })
        );
    }
    #[test]
    fn microphone_remains_available_without_an_output_endpoint() {
        let snapshot = mixer_snapshot(
            Err("No default output endpoint".into()),
            Some(crate::audio::AudioVolume {
                level: 0.7,
                muted: true,
            }),
        );
        assert!(snapshot.sessions.is_empty());
        assert!(snapshot.microphone.unwrap().muted);
        assert_eq!(
            snapshot.session_error.as_deref(),
            Some("No default output endpoint")
        );
        assert!(mixer_snapshot(Ok(Vec::new()), None).session_error.is_none());
    }
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "reads the signed-in user's live audio endpoints and sessions; run explicitly"]
    fn live_mixer_read_smoke() {
        let snapshot = platform::read();
        let mut ids = std::collections::HashSet::new();
        for session in &snapshot.sessions {
            assert!(!session.id.is_empty() && ids.insert(&session.id));
            assert!(session.level.is_finite() && (0.0..=1.0).contains(&session.level));
        }
        if let Some(microphone) = &snapshot.microphone {
            assert!(microphone.level.is_finite() && (0.0..=1.0).contains(&microphone.level));
        }
        println!(
            "read {} audio sessions; microphone available: {}",
            snapshot.sessions.len(),
            snapshot.microphone.is_some()
        );
    }
}
