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
    /// OS/2 weight class (100–900) — the @font-face `font-weight` of this face.
    pub weight: u16,
    /// `normal` / `italic` / `oblique` — the @font-face `font-style`.
    pub style: &'static str,
    /// CSS `font-stretch` percentage (50–200).
    pub stretch: f32,
    /// Installed for this user only (outside the Windows fonts dir). Chromium renders machine-wide
    /// fonts by name, so the webview only needs to @font-face these.
    pub per_user: bool,
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
    use fontdb::Database;
    let mut db = Database::new();
    db.load_system_fonts();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        db.load_fonts_dir(std::path::Path::new(&local).join("Microsoft\\Windows\\Fonts"));
    }
    let system_dir = std::env::var("SYSTEMROOT")
        .map(|root| format!("{root}\\Fonts\\"))
        .unwrap_or_else(|_| "C:\\Windows\\Fonts\\".into());
    // fontdb already scans the per-user dir via USERPROFILE, so the explicit LOCALAPPDATA load above
    // can list the same file twice — keep one entry per face.
    let mut seen = std::collections::HashSet::new();
    db.faces()
        .filter(|f| match &f.source {
            fontdb::Source::File(path) => seen.insert((path.clone(), f.index)),
            _ => false,
        })
        .filter_map(|f| system_font(f, &system_dir))
        .collect()
}

/// One listed face → the bridge record. Pure seam (tested): file-backed faces only, hidden `.`
/// aliases dropped, and `per_user` = the file is NOT under `system_dir` (the Windows fonts dir,
/// compared case-insensitively as Windows paths are).
fn system_font(f: &fontdb::FaceInfo, system_dir: &str) -> Option<SystemFont> {
    let fontdb::Source::File(path) = &f.source else {
        return None;
    };
    let name = f.families.first()?.0.clone();
    if name.starts_with('.') {
        return None; // hidden/system aliases
    }
    let path = path.to_string_lossy().into_owned();
    let per_user = !path
        .to_ascii_lowercase()
        .starts_with(&system_dir.to_ascii_lowercase());
    Some(SystemFont {
        name,
        font_name: f.post_script_name.clone(),
        path,
        weight: f.weight.0,
        style: match f.style {
            fontdb::Style::Normal => "normal",
            fontdb::Style::Italic => "italic",
            fontdb::Style::Oblique => "oblique",
        },
        stretch: css_stretch(f.stretch),
        per_user,
    })
}

/// The CSS `font-stretch` percentage for an OS/2 width class.
fn css_stretch(s: fontdb::Stretch) -> f32 {
    use fontdb::Stretch::*;
    match s {
        UltraCondensed => 50.0,
        ExtraCondensed => 62.5,
        Condensed => 75.0,
        SemiCondensed => 87.5,
        Normal => 100.0,
        SemiExpanded => 112.5,
        Expanded => 125.0,
        ExtraExpanded => 150.0,
        UltraExpanded => 200.0,
    }
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
            weight: 400,
            style: "normal",
            stretch: 100.0,
            per_user: false,
        }]);
        c.put(t0, fonts.clone());
        assert!(Arc::ptr_eq(
            &c.get(t0 + Duration::from_secs(60)).unwrap(),
            &fonts
        ));
        assert!(c.get(t0 + super::FONT_CACHE_TTL).is_none());
    }

    fn face(path: &str, family: &str) -> fontdb::FaceInfo {
        fontdb::FaceInfo {
            id: fontdb::ID::dummy(),
            source: fontdb::Source::File(path.into()),
            index: 0,
            families: vec![(family.into(), fontdb::Language::English_UnitedStates)],
            post_script_name: "Lora-BoldItalic".into(),
            style: fontdb::Style::Italic,
            weight: fontdb::Weight(700),
            stretch: fontdb::Stretch::SemiCondensed,
            monospaced: false,
        }
    }

    const SYS: &str = "C:\\Windows\\Fonts\\";

    #[test]
    fn system_font_reports_each_faces_weight_style_and_stretch() {
        let user = "C:\\Users\\me\\AppData\\Local\\Microsoft\\Windows\\Fonts\\Lora-BI.ttf";
        let f = system_font(&face(user, "Lora"), SYS).unwrap();
        assert_eq!(
            (f.name.as_str(), f.font_name.as_str(), f.path.as_str()),
            ("Lora", "Lora-BoldItalic", user)
        );
        assert_eq!((f.weight, f.style, f.stretch), (700, "italic", 87.5));
        assert!(f.per_user);
        let json = serde_json::to_value(&f).unwrap();
        assert_eq!(json["perUser"], true);
        assert_eq!(json["fontName"], "Lora-BoldItalic");
    }

    #[test]
    fn system_font_marks_windows_fonts_dir_machine_wide_and_drops_aliases_and_memory_faces() {
        let sys = system_font(
            &face("c:\\WINDOWS\\Fonts\\bahnschrift.ttf", "Bahnschrift"),
            SYS,
        );
        assert!(
            !sys.unwrap().per_user,
            "case-insensitive Windows fonts dir match"
        );
        assert!(system_font(&face("C:\\x\\a.ttf", ".Hidden"), SYS).is_none());
        let mut mem = face("C:\\x\\a.ttf", "Mem");
        mem.source = fontdb::Source::Binary(std::sync::Arc::new(vec![0u8]));
        assert!(system_font(&mem, SYS).is_none());
    }

    #[test]
    fn css_stretch_maps_the_width_classes() {
        use fontdb::Stretch::*;
        let got: Vec<f32> = [
            UltraCondensed,
            ExtraCondensed,
            Condensed,
            SemiCondensed,
            Normal,
            SemiExpanded,
            Expanded,
            ExtraExpanded,
            UltraExpanded,
        ]
        .into_iter()
        .map(css_stretch)
        .collect();
        assert_eq!(
            got,
            [50.0, 62.5, 75.0, 87.5, 100.0, 112.5, 125.0, 150.0, 200.0]
        );
    }
}
