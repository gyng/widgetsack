//! Bounded, read-only endpoint checks. Response bodies are never consumed and certificates are verified.
use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHealth {
    status: Option<u16>,
    latency_ms: u64,
    certificate_days: Option<i64>,
    error: Option<String>,
}

fn endpoint(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|_| "Enter a valid HTTP or HTTPS URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Use HTTP or HTTPS without embedded credentials".into());
    }
    Ok(url)
}

fn health_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .tls_info(true)
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

async fn check_headers(
    client: &reqwest::Client,
    url: reqwest::Url,
) -> Result<reqwest::Response, reqwest::Error> {
    let response = client.head(url.clone()).send().await?;
    if matches!(response.status().as_u16(), 405 | 501) {
        // Health routes often implement GET only; return after headers without consuming a body.
        drop(response);
        client.get(url).send().await
    } else {
        Ok(response)
    }
}

fn certificate_days(der: &[u8]) -> Option<i64> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    certificate_days_at(der, now)
}

#[cfg(target_os = "windows")]
fn certificate_days_at(der: &[u8], now: u64) -> Option<i64> {
    use windows::Win32::Security::Cryptography::{
        CertCreateCertificateContext, CertFreeCertificateContext, X509_ASN_ENCODING,
    };
    // SAFETY: the parser owns the returned context until freed below; it validates DER first.
    unsafe {
        let context = CertCreateCertificateContext(X509_ASN_ENCODING, der);
        if context.is_null() {
            return None;
        }
        let info = (*context).pCertInfo;
        let result = if info.is_null() {
            None
        } else {
            let expiry = (*info).NotAfter;
            let ticks = ((expiry.dwHighDateTime as u64) << 32) | expiry.dwLowDateTime as u64;
            let unix_secs = ticks / 10_000_000;
            Some((unix_secs as i64 - 11_644_473_600 - now as i64).div_euclid(86400))
        };
        let _ = CertFreeCertificateContext(Some(context));
        result
    }
}
#[cfg(not(target_os = "windows"))]
fn certificate_days_at(_der: &[u8], _now: u64) -> Option<i64> {
    None
}

/// Not studio-gated (overlay Service Health widgets poll it), so a non-studio caller may only check
/// a URL configured in the SAVED layout (`layout_grants`); the studio checks unsaved edits.
#[tauri::command]
pub async fn check_service_health(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    url: String,
) -> Result<ServiceHealth, String> {
    crate::layout_grants::authorize_saved(&app, window.label(), "service check", |grants| {
        grants.allows_health_url(&url)
    })
    .await?;
    check(url).await
}

async fn check(url: String) -> Result<ServiceHealth, String> {
    let url = endpoint(&url)?;
    let client = health_client()?;
    let start = Instant::now();
    // One total budget, including a possible HEAD → GET fallback.
    let response =
        match tokio::time::timeout(Duration::from_secs(10), check_headers(client, url)).await {
            Ok(response) => response.map_err(|e| e.to_string()),
            Err(_) => Err("Service check timed out after 10 seconds".into()),
        };
    let latency_ms = start.elapsed().as_millis() as u64;
    Ok(match response {
        Ok(response) => ServiceHealth {
            status: Some(response.status().as_u16()),
            latency_ms,
            certificate_days: response
                .extensions()
                .get::<reqwest::tls::TlsInfo>()
                .and_then(|t| t.peer_certificate())
                .and_then(certificate_days),
            error: None,
        },
        Err(error) => ServiceHealth {
            status: None,
            latency_ms,
            certificate_days: None,
            error: Some(error.to_string()),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn reads_real_der_expiry_at_a_fixed_time() {
        // Public-only fixture, not trusted or installed: CN=widgetsack.test, expires 2035-01-01 UTC.
        let der = include_bytes!("../test-data/service-health.der");
        assert_eq!(certificate_days_at(der, 1_735_689_600), Some(3652)); // 2025-01-01
        assert_eq!(certificate_days_at(der, 2_051_222_401), Some(-1)); // just after expiry
    }

    async fn request_line(stream: &mut tokio::net::TcpStream) -> String {
        use tokio::io::AsyncReadExt;
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            assert!(request.len() < 8192);
            let mut byte = [0];
            assert_eq!(stream.read(&mut byte).await.unwrap(), 1);
            request.push(byte[0]);
        }
        String::from_utf8(request)
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .to_owned()
    }

    #[tokio::test]
    async fn get_only_endpoints_are_checked_without_consuming_the_body() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut head, _) = listener.accept().await.unwrap();
            assert_eq!(request_line(&mut head).await, "HEAD /health HTTP/1.1");
            head.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            drop(head);
            let (mut get, _) = listener.accept().await.unwrap();
            assert_eq!(request_line(&mut get).await, "GET /health HTTP/1.1");
            get.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 999999\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        });
        let result = check(format!("http://{address}/health")).await.unwrap();
        assert_eq!(result.status, Some(200));
        assert_eq!(result.error, None);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn checks_headers_without_following_redirects_or_reading_bodies() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_eq!(request_line(&mut stream).await, "HEAD /health HTTP/1.1");
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: /login\r\nContent-Length: 999999\r\nConnection: close\r\n\r\n").await.unwrap();
        });
        let result = check(format!("http://{address}/health")).await.unwrap();
        assert_eq!(result.status, Some(302));
        assert_eq!(result.certificate_days, None);
        assert_eq!(result.error, None);
        server.await.unwrap();
    }
    #[test]
    fn validates_endpoints_and_keeps_local_services_supported() {
        assert!(endpoint("http://192.168.1.2:8123/health").is_ok());
        assert!(endpoint("https://example.com").is_ok());
        for bad in [
            "file:///c:/test",
            "ftp://nas",
            "https://user:pass@example.com",
            "bad",
        ] {
            assert!(endpoint(bad).is_err());
        }
    }
    #[test]
    fn malformed_certificate_is_unknown() {
        assert_eq!(certificate_days(&[]), None);
    }
    #[test]
    fn wire_shape() {
        let json = serde_json::to_value(ServiceHealth {
            status: Some(200),
            latency_ms: 42,
            certificate_days: Some(20),
            error: None,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "status": 200, "latencyMs": 42, "certificateDays": 20, "error": null })
        );
    }
}
