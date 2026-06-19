//! Album-art transport: serve cover bytes to the webview over a custom URI scheme instead of
//! shipping them through the JSON event bridge.
//!
//! WHY: a Tauri event payload is JSON, and serde_json renders a `Vec<u8>` as a JSON ARRAY OF
//! DECIMAL NUMBERS (`[137,80,78,...]`) — a ~3.5x text blow-up that the webview must then
//! `JSON.parse` into a boxed `number[]` and copy element-by-element into a `Uint8Array` before it
//! can even build a blob URL. For the 600–1500px covers players embed (hundreds of KB to a few MB)
//! that serialize → transfer → parse → copy chain is the dominant reason large art is slow to
//! appear. Here the bytes never touch JSON: `ImageWrapper` serializes to a tiny
//! `{ content_type, url, bytes }` descriptor whose `url` is `http://art.localhost/<hash>` (the
//! Windows/WebView2 form of an app-registered scheme — see `serve_art`), and the webview's
//! `<img src>` fetches the bytes natively from `serve_art`.
//!
//! The URL key is a CONTENT HASH of the bytes (`art_hash`), so identical covers (same album across
//! tracks) share a URL — the browser cache-hits and the crossfade `artKey` only changes on a real
//! art change. WebView2 caches custom-scheme responses by URL and does not reliably honour
//! `Cache-Control`, so varying the URL by content hash is what actually drives a refetch on change.
//!
//! Concentric architecture (AGENTS.md §5): the pure seams — `art_hash`, `art_url`, `ArtRegistry`,
//! `content_type_for`, `lookup`, `build_response` — hold the logic and the tests; `serve_art` /
//! `note_record` / `register_cover` are the thin Tauri-facing glue.

use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};

use tauri::http::{Request, Response, StatusCode, header};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext};

use crate::listener::{ImageWrapper, SessionUpdateEventWrapper};
use crate::state::SessionRecord;

/// How many distinct covers to retain in memory. Covers dedupe by content hash (same album → one
/// entry), so this bounds the registry to the recently-referenced set; a generous handful keeps an
/// in-flight crossfade's outgoing cover alive while capping worst-case retention. Eviction is
/// oldest-first (the handler/`<img>` only ever references current or just-superseded covers).
const MAX_COVERS: usize = 16;

/// Stable 64-bit content hash of the encoded cover bytes. Identical bytes → identical hash, so the
/// same album art always maps to the same URL/registry key. SipHash via the std default hasher —
/// zero extra dependency; not cryptographic, but collision-irrelevant for a bounded cover cache.
pub fn art_hash(data: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    data.hash(&mut hasher);
    hasher.finish()
}

/// The webview URL for a cover hash. On Windows/WebView2 an app-registered scheme `art` is served
/// at `http://art.localhost/<path>` (NOT `art://…`, which is the macOS/Linux form); this app is
/// Windows-only, so the http form is emitted directly. Mirror any change in the CSP `img-src` in
/// tauri.conf.json and in `parse_hash`.
pub fn art_url(hash: u64) -> String {
    format!("http://art.localhost/{hash}")
}

/// Extract the cover hash from a request path like `/12345`. Portable across platforms (the key is
/// always in the path, never the scheme/host), tolerant of a missing/garbage path.
pub fn parse_hash(path: &str) -> Option<u64> {
    path.trim_start_matches('/').parse::<u64>().ok()
}

/// Pick a safe, valid `Content-Type` for the response: trust a recognised declared MIME, else sniff
/// the magic bytes, else default to JPEG (the common album-art encoding). Returning a `&'static str`
/// from a fixed set guarantees a valid header value (never panics building the response).
pub fn content_type_for(declared: &str, data: &[u8]) -> &'static str {
    match declared.trim().to_ascii_lowercase().as_str() {
        "image/png" => "image/png",
        "image/jpeg" | "image/jpg" => "image/jpeg",
        "image/gif" => "image/gif",
        "image/webp" => "image/webp",
        "image/bmp" => "image/bmp",
        _ => sniff(data),
    }
}

fn sniff(data: &[u8]) -> &'static str {
    if data.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        "image/png"
    } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if data.starts_with(b"GIF8") {
        "image/gif"
    } else if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        "image/webp"
    } else if data.starts_with(b"BM") {
        "image/bmp"
    } else {
        "image/jpeg"
    }
}

/// Bounded content-addressed store of cover bytes: `hash -> Arc<ImageWrapper>`, with oldest-first
/// eviction past `cap`. Re-inserting an existing hash refreshes its recency (so a still-current
/// cover isn't evicted by a flurry of one-off covers). Pure data structure — unit-tested directly.
pub struct ArtRegistry {
    map: HashMap<u64, Arc<ImageWrapper>>,
    order: VecDeque<u64>,
    cap: usize,
}

impl ArtRegistry {
    pub fn with_capacity(cap: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            cap: cap.max(1),
        }
    }

    pub fn insert(&mut self, hash: u64, art: Arc<ImageWrapper>) {
        if self.map.insert(hash, art).is_some() {
            // Already present — move it to the most-recent position.
            if let Some(pos) = self.order.iter().position(|&h| h == hash) {
                self.order.remove(pos);
            }
            self.order.push_back(hash);
            return;
        }
        self.order.push_back(hash);
        while self.order.len() > self.cap {
            if let Some(old) = self.order.pop_front() {
                self.map.remove(&old);
            }
        }
    }

    pub fn get(&self, hash: u64) -> Option<&Arc<ImageWrapper>> {
        self.map.get(&hash)
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

impl Default for ArtRegistry {
    fn default() -> Self {
        Self::with_capacity(MAX_COVERS)
    }
}

/// Tauri-managed wrapper. A plain `std::sync::Mutex` (not a tokio async mutex): the uri-scheme
/// handler is a synchronous `Fn` with no `.await`, and registration only does a quick map write —
/// the value behind the lock is just data.
#[derive(Default)]
pub struct ArtState(pub Mutex<ArtRegistry>);

/// Look the cover up by the request path. Pure (no Tauri) so it's testable against a bare registry.
pub fn lookup<'a>(reg: &'a ArtRegistry, path: &str) -> Option<&'a Arc<ImageWrapper>> {
    parse_hash(path).and_then(|h| reg.get(h))
}

/// Build the HTTP response for a (possibly missing) cover: 200 with the sniffed content type and an
/// owned copy of the bytes, or 404. `Cache-Control: no-store` is belt-and-suspenders (the
/// content-hash URL is what actually drives refetch-on-change); the permissive ACAO header avoids a
/// custom-scheme CORS block on the `<img>` load.
pub fn build_response(art: Option<&ImageWrapper>) -> Response<Cow<'static, [u8]>> {
    match art {
        Some(img) => Response::builder()
            .status(StatusCode::OK)
            .header(
                header::CONTENT_TYPE,
                content_type_for(&img.content_type, &img.data),
            )
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Cow::Owned(img.data.clone()))
            .unwrap(),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Cow::Borrowed(&b""[..]))
            .unwrap(),
    }
}

/// The custom-scheme handler registered as `art` (see main.rs). Serves cover bytes from `ArtState`
/// keyed by the hash in the request path. Synchronous: a quick lock + lookup + clone, no I/O.
pub fn serve_art<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let state = ctx.app_handle().state::<ArtState>();
    let reg = state.0.lock().unwrap();
    build_response(lookup(&reg, request.uri().path()).map(|a| a.as_ref()))
}

/// Register a record's cover (if any) into the registry so its emitted `url` resolves. Idempotent;
/// the media-update record is the only kind carrying a cover (model/timeline updates strip it).
pub fn note_record(state: &ArtState, record: &SessionRecord) {
    if let Some(SessionUpdateEventWrapper::Media(_, Some(art))) = &record.last_media_update {
        state.0.lock().unwrap().insert(art.hash, art.clone());
    }
}

/// Convenience for callers holding an `AppHandle` (the live emit loop in main.rs): register the
/// cover BEFORE the record is emitted, so the webview's immediate fetch of the `url` finds it.
pub fn register_cover<R: Runtime>(app: &AppHandle<R>, record: &SessionRecord) {
    note_record(&app.state::<ArtState>(), record);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(content_type: &str, data: Vec<u8>) -> Arc<ImageWrapper> {
        Arc::new(ImageWrapper::new(content_type.to_string(), data))
    }

    #[test]
    fn art_hash_is_stable_and_content_addressed() {
        assert_eq!(art_hash(&[1, 2, 3]), art_hash(&[1, 2, 3]));
        assert_ne!(art_hash(&[1, 2, 3]), art_hash(&[1, 2, 4]));
        // Length is part of the hash, so a prefix differs from the whole.
        assert_ne!(art_hash(&[1, 2, 3]), art_hash(&[1, 2]));
    }

    #[test]
    fn art_url_and_parse_round_trip() {
        let h = art_hash(&[9, 9, 9]);
        let url = art_url(h);
        assert_eq!(url, format!("http://art.localhost/{h}"));
        // The webview hands us only the path portion.
        assert_eq!(parse_hash(&format!("/{h}")), Some(h));
        assert_eq!(parse_hash("/not-a-number"), None);
        assert_eq!(parse_hash("/"), None);
    }

    #[test]
    fn content_type_trusts_known_and_sniffs_unknown() {
        assert_eq!(content_type_for("image/png", &[]), "image/png");
        assert_eq!(content_type_for("IMAGE/JPG", &[]), "image/jpeg");
        // Unknown declared type → sniff the magic bytes.
        assert_eq!(content_type_for("", &[0x89, 0x50, 0x4E, 0x47]), "image/png");
        assert_eq!(
            content_type_for("application/octet-stream", &[0xFF, 0xD8, 0xFF]),
            "image/jpeg"
        );
        // Unrecognisable → jpeg default (never an invalid header value).
        assert_eq!(content_type_for("", &[0, 0, 0]), "image/jpeg");
    }

    #[test]
    fn registry_evicts_oldest_past_capacity() {
        let mut reg = ArtRegistry::with_capacity(2);
        reg.insert(1, img("image/png", vec![1]));
        reg.insert(2, img("image/png", vec![2]));
        reg.insert(3, img("image/png", vec![3])); // evicts hash 1
        assert_eq!(reg.len(), 2);
        assert!(reg.get(1).is_none());
        assert!(reg.get(2).is_some());
        assert!(reg.get(3).is_some());
    }

    #[test]
    fn reinserting_refreshes_recency_so_active_cover_survives() {
        let mut reg = ArtRegistry::with_capacity(2);
        reg.insert(1, img("image/png", vec![1]));
        reg.insert(2, img("image/png", vec![2]));
        reg.insert(1, img("image/png", vec![1])); // touch 1 → 2 is now oldest
        reg.insert(3, img("image/png", vec![3])); // evicts 2, not 1
        assert!(reg.get(1).is_some());
        assert!(reg.get(2).is_none());
        assert!(reg.get(3).is_some());
    }

    #[test]
    fn lookup_resolves_path_to_bytes() {
        let mut reg = ArtRegistry::default();
        let h = art_hash(&[7, 7, 7]);
        reg.insert(h, img("image/png", vec![7, 7, 7]));
        assert!(lookup(&reg, &format!("/{h}")).is_some());
        assert!(lookup(&reg, "/0").is_none());
        assert!(lookup(&reg, "/garbage").is_none());
    }

    #[test]
    fn build_response_serves_bytes_with_sniffed_type_or_404() {
        let png = ImageWrapper::new(String::new(), vec![0x89, 0x50, 0x4E, 0x47, 1, 2]);
        let ok = build_response(Some(&png));
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers().get(header::CONTENT_TYPE).unwrap(), "image/png");
        assert_eq!(ok.body().as_ref(), &[0x89, 0x50, 0x4E, 0x47, 1, 2]);

        let missing = build_response(None);
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert!(missing.body().is_empty());
    }

    #[test]
    fn note_record_registers_media_cover_only() {
        use crate::listener::SessionUpdateEventWrapper;
        use gsmtc::SessionModel;
        let model = SessionModel {
            playback: None,
            timeline: None,
            media: None,
            source: "p".to_string(),
        };
        let cover = Arc::new(ImageWrapper::new("image/png".to_string(), vec![1, 2, 3, 4]));
        let hash = cover.hash;
        let mut rec = SessionRecord {
            session_id: 1,
            source: Some("p".to_string()),
            timestamp_created: None,
            timestamp_updated: None,
            last_media_update: Some(SessionUpdateEventWrapper::Media(model.clone(), Some(cover))),
            last_model_update: None,
        };

        let state = ArtState::default();
        note_record(&state, &rec);
        assert!(
            state.0.lock().unwrap().get(hash).is_some(),
            "media cover is registered"
        );

        // A model/timeline update carries no cover → nothing new registered.
        rec.last_media_update = Some(SessionUpdateEventWrapper::Model(model));
        let state2 = ArtState::default();
        note_record(&state2, &rec);
        assert!(
            state2.0.lock().unwrap().is_empty(),
            "model update registers no cover"
        );
    }
}
