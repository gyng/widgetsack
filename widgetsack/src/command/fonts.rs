use std::{
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFont {
    /// Family name (CSS `font-family`).
    pub name: String,
    /// PostScript name (often a spaceless variant of the family).
    pub font_name: String,
    /// Absolute path to the font file (for the webview to @font-face via the asset protocol).
    pub path: String,
}

/// Enumerate installed fonts (incl. PER-USER ones) with their file paths. Chromium's sandboxed
/// webview won't render a per-user-installed font by name — but fontdb can find it here, and the
/// frontend then loads the file directly via @font-face + the asset protocol (the approach of
/// tauri-plugin-system-fonts, inlined). The per-user fonts dir is added explicitly (where Windows
/// puts "install for me only" fonts).
///
/// Enumerating parses the name tables of every installed face (hundreds of ms, disk-bound) and
/// every window asks on boot / theme change — so it runs on the blocking pool and the result is
/// memoised for `FONT_CACHE_TTL` (a font installed mid-session shows up within that).
#[tauri::command]
pub async fn system_fonts() -> Vec<SystemFont> {
    static CACHE: std::sync::Mutex<FontCache> = std::sync::Mutex::new(FontCache::new());
    // Single-flight: concurrent first callers (every overlay booting at once) share one scan.
    static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    let cached = |now: Instant| CACHE.lock().ok().and_then(|c| c.get(now));
    if let Some(fonts) = cached(Instant::now()) {
        return (*fonts).clone();
    }
    let _refresh = REFRESH.lock().await;
    if let Some(fonts) = cached(Instant::now()) {
        return (*fonts).clone();
    }
    let fonts = tokio::task::spawn_blocking(enumerate_system_fonts)
        .await
        .unwrap_or_default();
    let fonts = Arc::new(fonts);
    if let Ok(mut c) = CACHE.lock() {
        c.put(Instant::now(), fonts.clone());
    }
    (*fonts).clone()
}

/// How long a `system_fonts` scan is served from memory.
const FONT_CACHE_TTL: Duration = Duration::from_secs(300);

/// Memo for `system_fonts`. Pure seam (tested): `get(now)` hits only within `FONT_CACHE_TTL` of
/// the `put`.
struct FontCache {
    entry: Option<(Instant, Arc<Vec<SystemFont>>)>,
}

impl FontCache {
    const fn new() -> Self {
        FontCache { entry: None }
    }
    fn get(&self, now: Instant) -> Option<Arc<Vec<SystemFont>>> {
        match &self.entry {
            Some((at, fonts)) if now.duration_since(*at) < FONT_CACHE_TTL => Some(fonts.clone()),
            _ => None,
        }
    }
    fn put(&mut self, now: Instant, fonts: Arc<Vec<SystemFont>>) {
        self.entry = Some((now, fonts));
    }
}

fn enumerate_system_fonts() -> Vec<SystemFont> {
    use fontdb::{Database, Source};
    let mut db = Database::new();
    db.load_system_fonts();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        db.load_fonts_dir(std::path::Path::new(&local).join("Microsoft\\Windows\\Fonts"));
    }
    db.faces()
        .filter_map(|f| match &f.source {
            Source::File(path) => {
                let name = f.families.first()?.0.clone();
                if name.starts_with('.') {
                    return None; // hidden/system aliases
                }
                Some(SystemFont {
                    name,
                    font_name: f.post_script_name.clone(),
                    path: path.to_string_lossy().into_owned(),
                })
            }
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn font_cache_serves_within_ttl_only() {
        let t0 = Instant::now();
        let mut c = FontCache::new();
        assert!(c.get(t0).is_none());
        let fonts = Arc::new(vec![SystemFont {
            name: "Inter".into(),
            font_name: "Inter-Regular".into(),
            path: "C:\\Fonts\\Inter.ttf".into(),
        }]);
        c.put(t0, fonts.clone());
        assert!(Arc::ptr_eq(
            &c.get(t0 + Duration::from_secs(60)).unwrap(),
            &fonts
        ));
        assert!(c.get(t0 + super::FONT_CACHE_TTL).is_none());
    }
}
