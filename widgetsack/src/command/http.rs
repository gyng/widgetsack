/// Per-file download cap (manifest and each asset) — a plugin.json is a few KiB, a theme CSS tens.
pub(super) const FETCH_CAP: usize = 256 * 1024;

/// A 10s-timeout https client for the (small) manifest/asset fetches.
pub(super) fn install_http_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// GET `url` and return its body as text, enforcing `FETCH_CAP` while streaming (a hostile or
/// misconfigured server can't make us buffer an unbounded body).
pub(super) async fn fetch_text_capped(
    client: &reqwest::Client,
    url: &str,
) -> Result<String, String> {
    use futures_util::StreamExt;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("GET {url} failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GET {url} failed: HTTP {}", resp.status()));
    }
    if let Some(len) = resp.content_length()
        && len > FETCH_CAP as u64
    {
        return Err(format!("{url} is too large ({len} bytes; cap {FETCH_CAP})"));
    }
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("GET {url} failed mid-body: {e}"))?;
        if buf.len() + bytes.len() > FETCH_CAP {
            return Err(format!("{url} exceeded the {FETCH_CAP}-byte download cap"));
        }
        buf.extend_from_slice(&bytes);
    }
    String::from_utf8(buf).map_err(|_| format!("{url} is not valid UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn install_client_does_not_follow_redirects() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });

        let response = install_http_client()
            .unwrap()
            .get(format!("http://{address}/plugin.json"))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        server.join().unwrap();
    }

    #[test]
    fn package_http_requests_share_one_connection_pool() {
        let first = install_http_client().unwrap();
        let second = install_http_client().unwrap();
        assert!(std::ptr::eq(first, second));
    }
}
