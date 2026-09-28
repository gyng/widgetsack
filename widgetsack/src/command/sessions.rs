use crate::{AppState, SessionRecord};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize)]
pub struct UpdateResponse {
    pub sessions: HashMap<usize, SessionRecord>,
}

#[tauri::command]
pub async fn get_initial_sessions(
    _message: String,
    state: tauri::State<'_, AppState>,
    art: tauri::State<'_, crate::art::ArtState>,
) -> Result<UpdateResponse, String> {
    let sessions = state.sessions.lock().await;

    let mut cloned: HashMap<usize, SessionRecord> = HashMap::new();
    cloned.clone_from(&sessions);

    // Re-register each session's cover so the URLs in this snapshot resolve for a just-booted
    // overlay even if the live media events fired before its webview existed (art.rs).
    for record in cloned.values() {
        crate::art::note_record(&art, record);
    }

    Ok(UpdateResponse { sessions: cloned })
}
