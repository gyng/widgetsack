use std::{collections::HashMap, time::SystemTime};

use serde::Serialize;

use crate::bridge::{SESSION_CREATE_EVENT, SESSION_DELETE_EVENT, SESSION_UPDATE_EVENT};
use crate::{ManagerEventWrapper, SessionUpdateEventWrapper, event::NpSessionEvent, log};

#[derive(Debug, Clone, Serialize)]
pub struct SessionRecord {
    pub session_id: usize,
    pub source: Option<String>,
    pub timestamp_created: Option<SystemTime>,
    pub timestamp_updated: Option<SystemTime>,
    pub last_media_update: Option<SessionUpdateEventWrapper>,
    pub last_model_update: Option<SessionUpdateEventWrapper>,
}

pub fn updater(
    sessions: &mut HashMap<usize, SessionRecord>,
    event: NpSessionEvent,
) -> (&str, Option<SessionRecord>) {
    match event {
        NpSessionEvent::Create(
            _session_id_dupe,
            ManagerEventWrapper::SessionCreated { session_id, source },
        ) => {
            let new_record = SessionRecord {
                session_id,
                source: Some(source),
                timestamp_created: Some(SystemTime::now()),
                timestamp_updated: None,
                last_media_update: None,
                last_model_update: None,
            };
            let _ = (*sessions).insert(session_id, new_record.clone());
            (SESSION_CREATE_EVENT, Some(new_record))
        }
        NpSessionEvent::Create(_session_id_dupe, ev) => {
            log::warn("session", "unexpected manager event for Create")
                .field("event", format!("{ev:?}"))
                .emit();
            (SESSION_CREATE_EVENT, None)
        }
        NpSessionEvent::Update(session_id, ev) => {
            // Model/timeline (play/pause/seek) updates carry NO new album art — capture that before `ev`
            // is consumed so the emit below can strip the (unchanged) cover bytes rather than re-shipping
            // hundreds of KB over the IPC bridge on every tick.
            let is_model = matches!(ev, SessionUpdateEventWrapper::Model(_));
            let maybe_existing = (*sessions).get(&session_id);
            // TODO: create np-widget-specific models for sessions and map gsmtc to it

            let updated_record = if let Some(existing) = maybe_existing {
                let mut record_mut = SessionRecord {
                    session_id: existing.session_id,
                    source: existing.source.clone(),
                    timestamp_created: existing.timestamp_created,
                    timestamp_updated: Some(SystemTime::now()),
                    // Check if this can be CoW?
                    last_media_update: existing.last_media_update.clone(),
                    last_model_update: existing.last_model_update.clone(),
                };

                match ev {
                    SessionUpdateEventWrapper::Model(_) => {
                        record_mut.last_model_update = Some(ev);
                    }
                    SessionUpdateEventWrapper::Media(_, _) => {
                        record_mut.last_media_update = Some(ev);
                    }
                }

                record_mut
            } else {
                let updated_ev: SessionUpdateEventWrapper = ev;
                SessionRecord {
                    session_id,
                    source: None,
                    timestamp_created: Some(SystemTime::now()),
                    timestamp_updated: Some(SystemTime::now()),
                    last_media_update: match updated_ev {
                        SessionUpdateEventWrapper::Model(_) => None,
                        // FIXME: awful clone here
                        SessionUpdateEventWrapper::Media(_, _) => Some(updated_ev.clone()),
                    },
                    last_model_update: match updated_ev {
                        SessionUpdateEventWrapper::Model(_) => Some(updated_ev),
                        SessionUpdateEventWrapper::Media(_, _) => None,
                    },
                }
            };

            let _ = (*sessions).insert(session_id, updated_record.clone());
            // The stored record (above) keeps the art; the EMITTED one drops it on a model/timeline
            // update so we don't re-serialise + re-send the cover bytes to every webview each tick. The
            // frontend carries the previous cover forward by session_id (see stores.ts mergeMediaForward).
            // A media update keeps its art so a new cover still reaches the overlay.
            let emitted = if is_model {
                SessionRecord {
                    last_media_update: None,
                    ..updated_record
                }
            } else {
                updated_record
            };
            (SESSION_UPDATE_EVENT, Some(emitted))
        }
        NpSessionEvent::Delete(session_id, _ev) => {
            let maybe_deleted_record = (*sessions).remove(&session_id);

            if let Some(deleted_record) = maybe_deleted_record {
                (SESSION_DELETE_EVENT, Some(deleted_record))
            } else {
                (SESSION_DELETE_EVENT, None)
            }
        }
        NpSessionEvent::Unsupported(session_id, label) => {
            log::debug("gsmtc", "unsupported event")
                .field("label", &label)
                .field("session_id", format!("{session_id:?}"))
                .emit();
            ("unsupported", None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gsmtc::SessionModel;

    /// A minimal `SessionModel` for building `SessionUpdateEventWrapper` events without any media
    /// hardware. Only `source` is meaningful here; the rest are absent (None/empty).
    fn model(source: &str) -> SessionModel {
        SessionModel {
            playback: None,
            timeline: None,
            media: None,
            source: source.to_string(),
        }
    }

    #[test]
    fn create_yields_session_create_with_record_and_inserts() {
        let mut sessions = HashMap::new();
        let ev = NpSessionEvent::Create(
            7,
            ManagerEventWrapper::SessionCreated {
                session_id: 7,
                source: "fooplayer".to_string(),
            },
        );
        let (kind, delta) = updater(&mut sessions, ev);
        assert_eq!(kind, "session_create");
        let record = delta.expect("create should yield a record");
        assert_eq!(record.session_id, 7);
        assert_eq!(record.source.as_deref(), Some("fooplayer"));
        // The session is now tracked.
        assert!(sessions.contains_key(&7));
    }

    #[test]
    fn update_after_create_yields_session_update_and_keeps_source() {
        let mut sessions = HashMap::new();
        let _ = updater(
            &mut sessions,
            NpSessionEvent::Create(
                7,
                ManagerEventWrapper::SessionCreated {
                    session_id: 7,
                    source: "fooplayer".to_string(),
                },
            ),
        );

        let ev = NpSessionEvent::Update(7, SessionUpdateEventWrapper::Model(model("fooplayer")));
        let (kind, delta) = updater(&mut sessions, ev);
        assert_eq!(kind, "session_update");
        let record = delta.expect("update should yield a record");
        assert_eq!(record.session_id, 7);
        // Source carried over from the create; a model update populates last_model_update.
        assert_eq!(record.source.as_deref(), Some("fooplayer"));
        assert!(record.last_model_update.is_some());
        assert!(record.timestamp_updated.is_some());
    }

    #[test]
    fn model_update_strips_album_art_from_emitted_record_but_keeps_it_stored() {
        use crate::listener::ImageWrapper;
        use std::sync::Arc;
        let mut sessions = HashMap::new();
        let _ = updater(
            &mut sessions,
            NpSessionEvent::Create(
                7,
                ManagerEventWrapper::SessionCreated {
                    session_id: 7,
                    source: "p".to_string(),
                },
            ),
        );

        // A media update lands cover art on the session — and DOES carry it to the bridge.
        let media_ev = SessionUpdateEventWrapper::Media(
            model("p"),
            Some(Arc::new(ImageWrapper::new(
                "image/png".to_string(),
                vec![1, 2, 3, 4],
            ))),
        );
        let (_, media_delta) = updater(&mut sessions, NpSessionEvent::Update(7, media_ev));
        assert!(
            media_delta
                .expect("media update yields a record")
                .last_media_update
                .is_some(),
            "a media update must ship its album art"
        );

        // A following model (play/pause/seek) update must NOT re-ship the art on the emitted record…
        let (kind, model_delta) = updater(
            &mut sessions,
            NpSessionEvent::Update(7, SessionUpdateEventWrapper::Model(model("p"))),
        );
        assert_eq!(kind, "session_update");
        assert!(
            model_delta
                .expect("model update yields a record")
                .last_media_update
                .is_none(),
            "an emitted model/timeline update must not re-ship the (unchanged) album art"
        );
        // …but the STORED record keeps it, so get_initial_sessions / the frontend retain the cover.
        assert!(
            sessions.get(&7).unwrap().last_media_update.is_some(),
            "the stored record must keep the art for later reads"
        );
    }

    #[test]
    fn delete_yields_session_delete_with_record_and_removes() {
        let mut sessions = HashMap::new();
        let _ = updater(
            &mut sessions,
            NpSessionEvent::Create(
                7,
                ManagerEventWrapper::SessionCreated {
                    session_id: 7,
                    source: "fooplayer".to_string(),
                },
            ),
        );

        let ev = NpSessionEvent::Delete(7, ManagerEventWrapper::SessionRemoved { session_id: 7 });
        let (kind, delta) = updater(&mut sessions, ev);
        assert_eq!(kind, "session_delete");
        assert!(
            delta.is_some(),
            "deleting a tracked session returns its record"
        );
        // …and it is gone from the map afterwards.
        assert!(!sessions.contains_key(&7));
    }

    #[test]
    fn delete_unknown_session_yields_session_delete_without_record() {
        let mut sessions = HashMap::new();
        let ev = NpSessionEvent::Delete(42, ManagerEventWrapper::SessionRemoved { session_id: 42 });
        let (kind, delta) = updater(&mut sessions, ev);
        assert_eq!(kind, "session_delete");
        assert!(delta.is_none());
    }

    #[test]
    fn unsupported_event_yields_unsupported_without_record() {
        let mut sessions = HashMap::new();
        let ev = NpSessionEvent::Unsupported(Some(3), "CurrentSessionChanged".to_string());
        let (kind, delta) = updater(&mut sessions, ev);
        assert_eq!(kind, "unsupported");
        assert!(delta.is_none());
        // An unsupported event must not register a session.
        assert!(sessions.is_empty());
    }
}
