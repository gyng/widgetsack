use std::fmt;
use std::sync::Arc;

use gsmtc::{Image, ManagerEvent, SessionModel, SessionUpdateEvent};
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use tokio::sync::mpsc;

use crate::event::NpSessionEvent;
use crate::log;

pub async fn session_listener_windows_gsmtc(
    mut manager_rx: mpsc::UnboundedReceiver<ManagerEvent>,
    tx: mpsc::Sender<NpSessionEvent>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    while let Some(evt) = manager_rx.recv().await {
        match evt {
            ManagerEvent::SessionCreated {
                session_id,
                mut rx,
                source,
            } => {
                // `rx` is killing our .into() when destructured so manually create the struct here
                let evt_wrapper: ManagerEventWrapper = ManagerEventWrapper::SessionCreated {
                    session_id,
                    source: source.clone(),
                };

                log::info("gsmtc", "session created")
                    .field("session_id", session_id)
                    .field("source", &source)
                    .emit();

                let _ = tx.send(evt_wrapper.into()).await;

                let tx_child = tx.clone();
                tokio::spawn(async move {
                    while let Some(evt_update) = rx.recv().await {
                        let evt_update_wrapper: SessionUpdateEventWrapper = evt_update.into();
                        let _ = tx_child
                            .send(NpSessionEvent::from_session_update_event(
                                evt_update_wrapper,
                                session_id,
                            ))
                            .await;
                    }
                });
            }
            ManagerEvent::SessionRemoved { session_id } => {
                let evt_wrapper: ManagerEventWrapper =
                    ManagerEventWrapper::SessionRemoved { session_id };

                let _ = tx.send(evt_wrapper.into()).await;
                log::info("gsmtc", "session removed")
                    .field("session_id", session_id)
                    .emit();
            }
            ManagerEvent::CurrentSessionChanged {
                session_id: Some(id),
            } => {
                // TODO: reset frontend
                log::debug("gsmtc", "current session changed")
                    .field("session_id", id)
                    .emit();
            }
            ManagerEvent::CurrentSessionChanged { session_id: None } => {
                // TODO: clear frontend
                log::debug("gsmtc", "no current session").emit();
            }
        }
    }

    Ok(())
}

#[derive(Clone)]
pub struct ImageWrapper {
    pub content_type: String,
    pub data: Vec<u8>,
    /// Content hash of `data`, computed once at construction (`art::art_hash`). Drives the cover's
    /// bridge URL (`art::art_url`) and its registry key, so identical covers (same album across
    /// tracks) map to the same URL — a browser cache hit and a stable crossfade `artKey`.
    pub hash: u64,
}

impl ImageWrapper {
    pub fn new(content_type: String, data: Vec<u8>) -> Self {
        let hash = crate::art::art_hash(&data);
        ImageWrapper {
            content_type,
            data,
            hash,
        }
    }
}

impl From<Image> for ImageWrapper {
    fn from(value: Image) -> Self {
        ImageWrapper::new(value.content_type, value.data)
    }
}

// The cover bytes DO NOT cross the JSON bridge — that's the whole point of `art.rs`. Instead of
// serde_json rendering `data: Vec<u8>` as a multi-MB array of decimal numbers, an `ImageWrapper`
// serializes to a compact descriptor the frontend (`stores.ts` `ThumbnailInfo`) reads: `url` points
// the `<img>` at the custom `art` scheme handler, `bytes` is the retained byte count surfaced in the
// studio Diagnostics panel. Keep this in lockstep with `ThumbnailInfo` (AGENTS.md §5).
impl Serialize for ImageWrapper {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("ImageWrapper", 3)?;
        state.serialize_field("content_type", &self.content_type)?;
        state.serialize_field("url", &crate::art::art_url(self.hash))?;
        state.serialize_field("bytes", &self.data.len())?;
        state.end()
    }
}

impl fmt::Debug for ImageWrapper {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(
            f,
            "ImageWrapper {{ content_type: {}, data: u8[{}] }}",
            self.content_type,
            self.data.len()
        )
    }
}

// Serde's remote doesn't seem to work on enum fields? Image in Media wants to be Serialize, but that won't work.
// The cover art is held behind an `Arc` so carrying it forward across model/timeline updates
// (state.rs `updater`) and emitting it are pointer copies, not memcpy of the (hundreds-of-KB) bytes.
// `Arc<ImageWrapper>` serializes identically to `ImageWrapper` (serde `rc` feature) — the bridge JSON
// is unchanged, so the TS mirror in stores.ts needs no change.
#[derive(Clone, Debug, Serialize)]
pub enum SessionUpdateEventWrapper {
    Model(SessionModel),
    Media(SessionModel, Option<Arc<ImageWrapper>>),
}

impl From<gsmtc::SessionUpdateEvent> for SessionUpdateEventWrapper {
    fn from(value: gsmtc::SessionUpdateEvent) -> Self {
        match value {
            SessionUpdateEvent::Model(model) => SessionUpdateEventWrapper::Model(model),
            SessionUpdateEvent::Media(model, image) => {
                SessionUpdateEventWrapper::Media(model, image.map(|i| Arc::new(i.into())))
            }
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub enum ManagerEventWrapper {
    SessionCreated { session_id: usize, source: String },
    SessionRemoved { session_id: usize },
    CurrentSessionChanged { session_id: Option<usize> },
}

impl From<ManagerEvent> for ManagerEventWrapper {
    fn from(value: ManagerEvent) -> Self {
        match value {
            gsmtc::ManagerEvent::SessionCreated {
                session_id,
                rx: _,
                source,
            } => Self::SessionCreated { session_id, source },
            gsmtc::ManagerEvent::SessionRemoved { session_id } => {
                Self::SessionRemoved { session_id }
            }
            gsmtc::ManagerEvent::CurrentSessionChanged { session_id } => {
                Self::CurrentSessionChanged { session_id }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_wrapper_serializes_as_url_and_bytes_not_raw_data() {
        let data = vec![0x89u8, 0x50, 0x4E, 0x47, 1, 2, 3];
        let wrapper = ImageWrapper::new("image/png".to_string(), data.clone());
        let value = serde_json::to_value(&wrapper).expect("serialize");

        assert_eq!(value["content_type"], "image/png");
        assert_eq!(value["bytes"], data.len() as u64);
        // The whole point: the encoded bytes must NOT cross the JSON bridge.
        assert!(value.get("data").is_none(), "raw cover bytes must not be serialized");
        // The url is the content-hash scheme URL the webview's <img> fetches.
        assert_eq!(
            value["url"],
            crate::art::art_url(crate::art::art_hash(&data))
        );
    }
}
