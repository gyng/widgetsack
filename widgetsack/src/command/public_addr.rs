//! DNS-rebinding guard for the package fetch proxy. A hostname check alone is not enough: the
//! connection resolves the name again, and a hostile DNS server can answer with a LAN / loopback /
//! cloud-metadata address the second time. So the host is resolved ONCE here, every answer is
//! vetted, and the request is pinned to the vetted address with reqwest's `resolve` override
//! (TLS SNI and certificate validation still use the hostname from the URL).
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// PURE SEAM: is `ip` a globally routable unicast address a third-party package may reach?
/// Refuses unspecified, loopback, private (RFC 1918), shared/CGNAT (100.64/10), link-local
/// (incl. 169.254.169.254 metadata), IETF/documentation/benchmark/reserved ranges, broadcast and
/// multicast — and, for IPv6, unique-local, link-/site-local, multicast, documentation, Teredo,
/// and any address that EMBEDS an IPv4 (mapped, compatible, NAT64, 6to4) whose IPv4 is non-public.
pub(super) fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0 // "this network" incl. 0.0.0.0
        || a == 10
        || a == 127
        || (a == 100 && (64..128).contains(&b)) // shared address space / CGNAT
        || (a == 169 && b == 254) // link-local, cloud metadata
        || (a == 172 && (16..32).contains(&b))
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 192 && b == 0 && c == 2) // TEST-NET-1
        || (a == 192 && b == 168)
        || (a == 198 && (18..20).contains(&b)) // benchmarking
        || (a == 198 && b == 51 && c == 100) // TEST-NET-2
        || (a == 203 && b == 0 && c == 113) // TEST-NET-3
        || a >= 224) // multicast, reserved, broadcast
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let seg = ip.segments();
    let embedded =
        |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    if ip.is_unspecified() || ip.is_loopback() {
        return false;
    }
    // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (deprecated compatible) reach the IPv4 address.
    if seg[..5] == [0; 5] && (seg[5] == 0xffff || seg[5] == 0) {
        return is_public_v4(embedded(seg[6], seg[7]));
    }
    // NAT64 well-known prefix 64:ff9b::/96 translates to the embedded IPv4.
    if seg[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return is_public_v4(embedded(seg[6], seg[7]));
    }
    // 6to4 2002:AABB:CCDD::/48 tunnels to the embedded IPv4.
    if seg[0] == 0x2002 {
        return is_public_v4(embedded(seg[1], seg[2]));
    }
    !((seg[0] & 0xff00) == 0xff00 // multicast
        || (seg[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
        || (seg[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
        || (seg[0] & 0xffc0) == 0xfec0 // site-local (deprecated) fec0::/10
        || (seg[0] == 0x2001 && seg[1] == 0x0db8) // documentation
        || (seg[0] == 0x2001 && seg[1] == 0) // Teredo: can tunnel anywhere
        || (seg[0] == 0x64 && seg[1] == 0xff9b) // local-use NAT64 64:ff9b:1::/48
        || seg[..4] == [0x100, 0, 0, 0] // discard-only 100::/64
        || seg[0] == 0) // the rest of ::/16 (reserved; mapped/compatible handled above)
}

/// PURE SEAM: vet every resolved address (a host answering with ANY internal address is refused,
/// so a mixed answer cannot be used to race the pin) and return the one to pin the request to.
pub(super) fn vet_resolved(
    addrs: impl IntoIterator<Item = SocketAddr>,
) -> Result<SocketAddr, String> {
    let mut first = None;
    for addr in addrs {
        if !is_public_ip(addr.ip()) {
            return Err("request URL resolves to a local or internal address".into());
        }
        first.get_or_insert(addr);
    }
    first.ok_or_else(|| "request host did not resolve".into())
}

/// Resolve `host` once and return a vetted public address (port is the https default; reqwest
/// connects to the URL's port regardless).
pub(super) async fn resolve_public(host: &str) -> Result<SocketAddr, String> {
    let addrs = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|_| "request host did not resolve".to_string())?;
    vet_resolved(addrs)
}

/// A one-request client that connects `host` ONLY to `addr`: no re-resolution, no redirects, no
/// proxy (a proxy would resolve the name itself and defeat the pin), 10s timeout.
pub(super) fn pinned_client(host: &str, addr: SocketAddr) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .no_proxy()
        .resolve(host, addr)
        .build()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn internal_and_special_addresses_are_refused() {
        for s in [
            "0.0.0.0",
            "0.1.2.3",
            "127.0.0.1",
            "127.255.0.9",
            "10.0.0.5",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254", // cloud metadata
            "169.254.0.1",
            "100.64.0.1", // CGNAT
            "100.127.255.255",
            "192.0.0.170",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.7",
            "203.0.113.9",
            "224.0.0.1",
            "239.255.255.250",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1", // IPv4-mapped loopback
            "::ffff:169.254.169.254",
            "::ffff:10.1.2.3",
            "::127.0.0.1",       // IPv4-compatible
            "64:ff9b::a00:1",    // NAT64 → 10.0.0.1
            "2002:c0a8:0101::1", // 6to4 → 192.168.1.1
            "fc00::1",
            "fd00:ec2::254", // AWS IPv6 metadata (unique local)
            "fe80::1",
            "febf::1",
            "fec0::1",
            "ff02::1",
            "2001:db8::1",
            "2001:0:4136:e378::1", // Teredo
            "100::1",
            "64:ff9b:1::a00:1",
        ] {
            assert!(!is_public_ip(ip(s)), "{s} should be refused");
        }
    }

    #[test]
    fn public_addresses_are_allowed() {
        for s in [
            "1.1.1.1",
            "8.8.8.8",
            "93.184.216.34",
            "100.63.255.255", // just below CGNAT
            "100.128.0.1",    // just above CGNAT
            "172.15.255.255",
            "172.32.0.1",
            "169.253.1.1",
            "198.17.1.1",
            "223.255.255.254",
            "2606:4700:4700::1111",
            "2a00:1450:4001::200e",
            "::ffff:8.8.8.8",    // mapped public
            "64:ff9b::808:808",  // NAT64 → 8.8.8.8
            "2002:0808:0808::1", // 6to4 → 8.8.8.8
        ] {
            assert!(is_public_ip(ip(s)), "{s} should be allowed");
        }
    }

    #[test]
    fn any_internal_answer_refuses_the_whole_resolution() {
        let public: SocketAddr = "1.1.1.1:443".parse().unwrap();
        let other: SocketAddr = "[2606:4700::1111]:443".parse().unwrap();
        let internal: SocketAddr = "127.0.0.1:443".parse().unwrap();
        assert_eq!(vet_resolved([public, other]), Ok(public));
        assert!(vet_resolved([public, internal]).is_err());
        assert!(vet_resolved([internal, public]).is_err());
        assert!(vet_resolved([]).unwrap_err().contains("did not resolve"));
    }

    #[tokio::test]
    async fn pinned_client_connects_only_to_the_vetted_address() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 2048];
            let n = stream.read(&mut request).await.unwrap();
            let text = String::from_utf8_lossy(&request[..n]).to_string();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await
                .unwrap();
            text
        });
        // The name never resolves via DNS (.invalid is reserved); only the pin can reach the server.
        let client = pinned_client("pinned.invalid", address).unwrap();
        let url = format!("http://pinned.invalid:{}/data", address.port());
        let response = client.get(&url).send().await.unwrap();
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(response.text().await.unwrap(), "ok");
        let request = server.await.unwrap();
        // The Host header still names the original host (TLS SNI follows the same URL host).
        assert!(
            request
                .to_ascii_lowercase()
                .contains("host: pinned.invalid"),
            "{request}"
        );
    }
}
