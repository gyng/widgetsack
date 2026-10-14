//! Bounded HTTP response IO shared by native adapters.

pub(crate) fn request_error(error: reqwest::Error) -> String {
    error.without_url().to_string()
}

pub(crate) async fn read_body(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;
    let length = response.content_length();
    let stream = response
        .bytes_stream()
        .map(|result| result.map_err(request_error));
    read_bounded_stream(stream, length, limit).await
}

pub(crate) async fn read_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
    limit: usize,
) -> Result<T, String> {
    let bytes = read_body(response, limit).await?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
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

    async fn fixture_response(wire: &'static str) -> reqwest::Response {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 1024];
            assert!(socket.read(&mut request).unwrap() > 0);
            socket.write_all(wire.as_bytes()).unwrap();
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}/private?token=test-secret"))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
            .unwrap();
        server.join().unwrap();
        response
    }

    #[tokio::test]
    async fn bounded_response_decodes_json_and_rejects_invalid_or_truncated_data() {
        let response = fixture_response(
            "HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\n{\"a\":1}",
        )
        .await;
        assert_eq!(
            read_json::<serde_json::Value>(response, 7).await.unwrap(),
            serde_json::json!({"a":1})
        );
        let response =
            fixture_response("HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx")
                .await;
        assert!(read_json::<serde_json::Value>(response, 7).await.is_err());
        let response =
            fixture_response("HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nx")
                .await;
        let error = read_body(response, 10).await.unwrap_err();
        assert!(error.contains("mid-body"), "{error}");
        assert!(!error.contains("test-secret"), "{error}");
        assert!(!error.contains("private"), "{error}");
    }

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
}
