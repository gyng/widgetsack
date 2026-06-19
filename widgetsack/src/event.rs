#![allow(clippy::large_enum_variant)]

use serde::Serialize;
use tauri::Emitter;

use crate::{
    listener::{ManagerEventWrapper, SessionUpdateEventWrapper},
    log,
    state::SessionRecord,
};

pub fn emit_to_bridge<R: tauri::Runtime>(
    emitter: &impl Emitter<R>,
    delta: (&str, Option<SessionRecord>),
) {
    match delta {
        (event_type, Some(record)) => {
            let _ = emitter.emit(event_type, record);
        }
        (event_type, None) => {
            // FIXME: Might not be true in all cases
            log::debug("bridge", "skipped emit: no session record")
                .field("event_type", event_type)
                .emit();
        }
    };
}

#[derive(Clone, Debug, Serialize)]
pub enum NpSessionEvent {
    /// session ID, event
    /// ManagerEvent actually already contains session_id but we still keep session ID to be consistent
    Create(usize, ManagerEventWrapper),
    Update(usize, SessionUpdateEventWrapper),
    Delete(usize, ManagerEventWrapper),
    Unsupported(Option<usize>, String),
}

impl From<ManagerEventWrapper> for NpSessionEvent {
    fn from(event: ManagerEventWrapper) -> Self {
        match &event {
            ManagerEventWrapper::SessionCreated {
                session_id,
                source: _,
            } => NpSessionEvent::Create(*session_id, event),
            ManagerEventWrapper::SessionRemoved { session_id } => {
                NpSessionEvent::Delete(*session_id, event)
            }
            ManagerEventWrapper::CurrentSessionChanged { session_id } => {
                NpSessionEvent::Unsupported(*session_id, "CurrentSessionChanged".to_owned())
            }
        }
    }
}

impl NpSessionEvent {
    pub fn from_session_update_event(event: SessionUpdateEventWrapper, session_id: usize) -> Self {
        NpSessionEvent::Update(session_id, event)
    }
}
