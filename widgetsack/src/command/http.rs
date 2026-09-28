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
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("GET {url} failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GET {url} failed: HTTP {}", resp.status()));
    }
    let buf = read_body_capped(resp)
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    String::from_utf8(buf).map_err(|_| format!("{url} is not valid UTF-8"))
}

/// Read a response under the shared cap. Status policy belongs to the caller.
pub(super) async fn read_body_capped(response: reqwest::Response) -> Result<Vec<u8>, String> {
    let length = response.content_length();
    read_bounded_stream(response.bytes_stream(), length, FETCH_CAP).await
}

async fn read_bounded_stream<S, B, E>(
    stream: S,
    length: Option<u64>,
    limit: usize,
) -> Result<Vec<u8>, String>
where
    S: futures_util::Stream<Item = Result<B, E>>,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    use futures_util::StreamExt;
    if length.is_some_and(|n| n > limit as u64) {
        return Err(format!("response too large (cap {limit} bytes)"));
    }
    futures_util::pin_mut!(stream);
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("response failed mid-body: {e}"))?;
        let bytes = chunk.as_ref();
        if bytes.len() > limit - body.len() {
            return Err(format!("response exceeded the {limit}-byte cap"));
        }
        body.extend_from_slice(bytes);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bounded_body_accepts_exact_limit_and_rejects_overflow_or_stream_failure() {
        use futures_util::stream;
        assert_eq!(
            read_bounded_stream(stream::iter([Ok::<_, &str>(b"ab"), Ok(b"cd")]), None, 4)
                .await
                .unwrap(),
            b"abcd"
        );
        assert!(
            read_bounded_stream(stream::iter([Ok::<_, &str>(b"ab"), Ok(b"cd")]), None, 3)
                .await
                .unwrap_err()
                .contains("exceeded")
        );
        assert!(
            read_bounded_stream(stream::iter([Ok(b"ab"), Err("disconnected")]), None, 4)
                .await
                .unwrap_err()
                .contains("disconnected")
        );
    }

    #[tokio::test]
    async fn oversized_declared_body_is_rejected_before_polling() {
        let stream = futures_util::stream::poll_fn(
            |_| -> std::task::Poll<Option<Result<Vec<u8>, String>>> {
                panic!("must not poll an oversized body")
            },
        );
        assert!(
            read_bounded_stream(stream, Some(5), 4)
                .await
                .unwrap_err()
                .contains("too large")
        );
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
