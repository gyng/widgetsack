//! Top-level navigation guard for EVERY webview (the config-defined `main` overlay, the studio, and
//! the JS-spawned secondary overlays). The app's pages are its own bundled SPA; nothing legitimate
//! ever navigates a window's top frame elsewhere. But an embedded `<iframe>` widget (with the
//! sandbox relaxed) or a hostile theme/link could try `top.location = …` / `<a target=_top>` — and a
//! webview steered to an attacker's page would carry the Tauri IPC bridge with it. So the only
//! allowed top-level destinations are the app's own origin (`tauri://localhost` / `http(s)://
//! tauri.localhost` in release, the Vite dev server in debug builds) and `about:blank`; everything
//! else is denied and logged. Installed as a plugin so the one hook covers all webviews (Tauri v2
//! has no builder-level `on_navigation`; `WebviewWindowBuilder::on_navigation` would miss the
//! config-defined `main` window). The decision is a pure seam (`navigation_allowed`), unit-tested.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, Url};

use crate::log;

/// The Vite dev server `devUrl` from tauri.conf.json — only honoured in debug builds.
const DEV_HOST: &str = "localhost";
const DEV_PORT: u16 = 1420;

/// PURE SEAM: may a webview's TOP frame navigate to `url`? `dev` is `cfg!(debug_assertions)` at the
/// call site (passed in so both arms are testable).
pub fn navigation_allowed(url: &Url, dev: bool) -> bool {
    match url.scheme() {
        // The production app origin (`tauri://localhost`) and the custom-scheme forms Tauri uses on
        // Windows (`http://tauri.localhost`, or https with `useHttpsScheme`).
        "tauri" => true,
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") => true,
            Some(h) if dev && h == DEV_HOST && url.port() == Some(DEV_PORT) => {
                url.scheme() == "http"
            }
            _ => false,
        },
        // A fresh webview / `window.open()` target before its real load.
        "about" => url.as_str() == "about:blank",
        _ => false,
    }
}

/// The plugin: deny (and warn) any top-level navigation off the app origin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navguard")
        .on_navigation(|webview, url| {
            let ok = navigation_allowed(url, cfg!(debug_assertions));
            if !ok {
                log::warn(
                    "navguard",
                    "blocked top-level navigation off the app origin",
                )
                .field("window", webview.label())
                .field("url", url.as_str())
                .emit();
            }
            ok
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn allows_the_app_origin_and_about_blank() {
        assert!(navigation_allowed(&u("tauri://localhost/"), false));
        assert!(navigation_allowed(
            &u("tauri://localhost/index.html?x=1"),
            false
        ));
        assert!(navigation_allowed(&u("http://tauri.localhost/"), false));
        assert!(navigation_allowed(
            &u("https://tauri.localhost/studio"),
            false
        ));
        assert!(navigation_allowed(&u("about:blank"), false));
    }

    #[test]
    fn allows_the_vite_dev_server_only_in_dev() {
        assert!(navigation_allowed(&u("http://localhost:1420/"), true));
        assert!(!navigation_allowed(&u("http://localhost:1420/"), false));
        assert!(!navigation_allowed(&u("http://localhost:3000/"), true)); // wrong port
        assert!(!navigation_allowed(&u("https://localhost:1420/"), true)); // vite is plain http
    }

    #[test]
    fn denies_everything_else() {
        for s in [
            "https://evil.example/",
            "http://evil.example/",
            "https://tauri.localhost.evil.example/",
            "http://localhost/",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "data:text/html,<script>1</script>",
            "about:srcdoc",
            "ftp://x/",
        ] {
            assert!(!navigation_allowed(&u(s), true), "{s} must be denied");
        }
    }
}
