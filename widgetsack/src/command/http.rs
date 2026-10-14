/// Per-file package cap, shared by local reads and downloads.
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
    let resp = client.get(url).send().await.map_err(|e| {
        format!(
            "package download failed: {}",
            crate::http_response::request_error(e)
        )
    })?;
    if !resp.status().is_success() {
        return Err(format!("package download failed: HTTP {}", resp.status()));
    }
    let buf = read_body_capped(resp)
        .await
        .map_err(|e| format!("package download failed: {e}"))?;
    String::from_utf8(buf).map_err(|_| "package download is not valid UTF-8".into())
}

/// Read a response under the shared cap. Status policy belongs to the caller.
pub(super) async fn read_body_capped(response: reqwest::Response) -> Result<Vec<u8>, String> {
    crate::http_response::read_body(response, FETCH_CAP).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn download_errors_do_not_disclose_url_secrets() {
        use std::io::{Read, Write};
        for response in [
            &b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"[..],
            &b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\n\xff"[..],
            &b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nx"[..],
            &b""[..],
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 2048];
                let _ = stream.read(&mut request);
                stream.write_all(response).unwrap();
            });
            let url = format!(
                "http://user:synthetic-secret@{address}/synthetic-secret/plugin.json?token=synthetic-secret"
            );
            let error = fetch_text_capped(install_http_client().unwrap(), &url)
                .await
                .unwrap_err();
            server.join().unwrap();
            assert!(
                !error.contains("synthetic-secret"),
                "URL disclosed in error: {error}"
            );
        }
    }

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
