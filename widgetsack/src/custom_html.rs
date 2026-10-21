//! Ephemeral isolated HTML documents. Never serves files or grants the child an IPC origin.
use std::{borrow::Cow, collections::HashMap, sync::Mutex};
use tauri::{
    Manager, Runtime, State, UriSchemeContext,
    http::{Request, Response},
};

const MAX_DOCUMENT_BYTES: usize = 512 * 1024;
const MAX_DOCUMENTS: usize = 128;
pub const DOCUMENT_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";

#[derive(Default)]
pub struct HtmlRegistry {
    documents: HashMap<String, String>,
}

impl HtmlRegistry {
    fn insert(&mut self, token: String, document: String) -> Result<String, String> {
        if token.len() != 36 || !token.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
            return Err("Invalid document token".into());
        }
        if document.len() > MAX_DOCUMENT_BYTES {
            return Err("Custom HTML exceeds 512 KiB".into());
        }
        if !self.documents.contains_key(&token) && self.documents.len() >= MAX_DOCUMENTS {
            return Err("Too many custom HTML documents".into());
        }
        let url = format!("http://customhtml.localhost/{token}");
        self.documents.insert(token, document);
        Ok(url)
    }
}

#[derive(Default)]
pub struct CustomHtmlState(Mutex<HtmlRegistry>);

#[tauri::command]
pub fn register_custom_html(
    state: State<'_, CustomHtmlState>,
    token: String,
    document: String,
) -> Result<String, String> {
    state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(token, document)
}

#[tauri::command]
pub fn release_custom_html(state: State<'_, CustomHtmlState>, token: String) {
    state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .documents
        .remove(&token);
}

pub fn response(document: Option<&str>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(if document.is_some() { 200 } else { 404 })
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", DOCUMENT_CSP)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(Cow::Owned(
            document
                .unwrap_or("Document unavailable")
                .as_bytes()
                .to_vec(),
        ))
        .expect("static response headers")
}

pub fn serve<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let state = ctx.app_handle().state::<CustomHtmlState>();
    let registry = state.0.lock().unwrap_or_else(|e| e.into_inner());
    response(
        registry
            .documents
            .get(request.uri().path().trim_start_matches('/'))
            .map(String::as_str),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    const TOKEN: &str = "00000000-0000-4000-a000-000000000000";
    #[test]
    fn bounds_tokens_document_size_and_capacity_without_evicting_live_documents() {
        let mut registry = HtmlRegistry::default();
        assert!(registry.insert("invalid".into(), "x".into()).is_err());
        assert!(registry.insert("z".repeat(36), "x".into()).is_err());
        assert!(
            registry
                .insert(TOKEN.into(), "x".repeat(MAX_DOCUMENT_BYTES + 1))
                .is_err()
        );
        assert_eq!(
            registry.insert(TOKEN.into(), "hello".into()).unwrap(),
            format!("http://customhtml.localhost/{TOKEN}")
        );
        for i in 1..MAX_DOCUMENTS {
            registry.insert(format!("{i:036x}"), "x".into()).unwrap();
        }
        assert!(registry.insert("f".repeat(36), "x".into()).is_err());
        assert!(registry.insert(TOKEN.into(), "updated".into()).is_ok());
        registry.documents.remove(TOKEN);
        assert!(registry.insert("f".repeat(36), "x".into()).is_ok());
    }
    #[test]
    fn serves_only_registered_documents_with_isolated_policy() {
        let good = response(Some("<h1>hello</h1>"));
        assert_eq!(good.status(), 200);
        assert_eq!(good.headers()["Content-Security-Policy"], DOCUMENT_CSP);
        assert!(DOCUMENT_CSP.contains("connect-src 'none'"));
        assert!(DOCUMENT_CSP.contains("sandbox allow-scripts"));
        assert!(!DOCUMENT_CSP.contains("allow-same-origin"));
        assert_eq!(good.headers()["Cache-Control"], "no-store");
        assert_eq!(good.body().as_ref(), b"<h1>hello</h1>");
        assert_eq!(response(None).status(), 404);
    }
}
