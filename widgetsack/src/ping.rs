//! Ping / "is my internet up?" source. A demand-gated background poller (peer to the sensor loop): each
//! tick it reads the active sensor set, extracts the hosts named by mounted `net.ping.<host>.{ms,up}`
//! sensors, and ICMP-pings exactly those via `IcmpSendEcho` (no admin, no raw socket). It emits
//! `net.ping.<host>.ms` (round-trip ms) and `net.ping.<host>.up` (1/0) over the existing telemetry
//! event. Nothing is pinged unless a Ping widget is mounted — the `*` studio wildcard is ignored (it
//! can't name a host), so even an open studio costs nothing until a Ping widget is actually placed.
//!
//! Outer-ring adapter: the pure host-parsing + sample-shaping seams are unit-tested without Win32 or a
//! network; the ICMP/DNS calls live at the edge, cfg-gated to Windows.

use std::collections::{HashMap, HashSet};
#[cfg(target_os = "windows")]
use std::net::Ipv4Addr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::sensors::{ActiveSensors, SensorSample, TELEMETRY_EVENT};

/// How often to ping the mounted hosts. "Is my internet up" doesn't need sub-second resolution.
const INTERVAL: Duration = Duration::from_secs(3);
/// Per-host ICMP timeout — past this the host is reported down for the tick.
const PING_TIMEOUT_MS: u32 = 1000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Extract `<host>` from `net.ping.<host>.ms` / `net.ping.<host>.up`. `None` for anything else. The
/// host may itself contain dots (an IP literal), so we strip the fixed prefix + suffix rather than
/// splitting on `.`. Pure.
fn host_of(id: &str) -> Option<&str> {
    let rest = id.strip_prefix("net.ping.")?;
    rest.strip_suffix(".ms")
        .or_else(|| rest.strip_suffix(".up"))
        .filter(|h| !h.is_empty())
}

/// The distinct hosts named by the active `net.ping.*` ids (sorted, deduped). The `*` wildcard is
/// ignored — it can't enumerate hosts. Pure.
pub fn hosts_from_active(active: &HashMap<String, HashSet<String>>) -> Vec<String> {
    let mut set: HashSet<&str> = HashSet::new();
    for ids in active.values() {
        for id in ids {
            if let Some(host) = host_of(id) {
                set.insert(host);
            }
        }
    }
    let mut v: Vec<String> = set.into_iter().map(str::to_string).collect();
    v.sort();
    v
}

/// The (ms, up) sensor ids for a host.
fn ping_ids(host: &str) -> (String, String) {
    (format!("net.ping.{host}.ms"), format!("net.ping.{host}.up"))
}

/// Samples for one host's result: `up=1` + the latency when reachable, `up=0` (no ms) when not. Pure.
fn samples_for(host: &str, rtt_ms: Option<f64>, ts: u64) -> Vec<SensorSample> {
    let (ms_id, up_id) = ping_ids(host);
    match rtt_ms {
        Some(ms) => vec![
            SensorSample::scalar(up_id, ts, 1.0),
            SensorSample::scalar(ms_id, ts, ms),
        ],
        None => vec![SensorSample::scalar(up_id, ts, 0.0)],
    }
}

/// Resolve a host string to an IPv4 address: an IP literal directly (no DNS), else the first A record.
#[cfg(target_os = "windows")]
fn resolve_ipv4(host: &str) -> Option<Ipv4Addr> {
    use std::net::{IpAddr, ToSocketAddrs};
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return Some(ip);
    }
    (host, 0u16)
        .to_socket_addrs()
        .ok()?
        .find_map(|sa| match sa.ip() {
            IpAddr::V4(v4) => Some(v4),
            IpAddr::V6(_) => None,
        })
}

/// ICMP-echo `addr`, returning the round-trip time in ms, or `None` on timeout / unreachable. Uses the
/// `IcmpSendEcho` helper (no admin, no raw socket). Blocking — call from `spawn_blocking`.
#[cfg(target_os = "windows")]
fn icmp_ping(addr: Ipv4Addr, timeout_ms: u32) -> Option<f64> {
    use windows::Win32::NetworkManagement::IpHelper::{
        ICMP_ECHO_REPLY, IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho,
    };

    // SAFETY: IcmpCreateFile returns a handle (Err / INVALID_HANDLE_VALUE on failure).
    let handle = unsafe { IcmpCreateFile() }.ok()?;
    // DestinationAddress is an IPAddr DWORD in network byte order; the octets are its little-endian bytes.
    let dest = u32::from_le_bytes(addr.octets());
    let request = [0u8; 32];
    // Reply buffer must hold one ICMP_ECHO_REPLY + the echoed request data + room for an ICMP error.
    let reply_size = std::mem::size_of::<ICMP_ECHO_REPLY>() + request.len() + 8;
    let mut reply = vec![0u8; reply_size];
    // SAFETY: `request`/`reply` are valid buffers of the stated sizes; `handle` is open.
    let replies = unsafe {
        IcmpSendEcho(
            handle,
            dest,
            request.as_ptr().cast(),
            request.len() as u16,
            None,
            reply.as_mut_ptr().cast(),
            reply_size as u32,
            timeout_ms,
        )
    };
    let rtt = if replies > 0 {
        // SAFETY: on success the buffer begins with a populated ICMP_ECHO_REPLY.
        let r = unsafe { &*(reply.as_ptr() as *const ICMP_ECHO_REPLY) };
        // Status 0 == IP_SUCCESS; RoundTripTime is in milliseconds.
        (r.Status == 0).then_some(r.RoundTripTime as f64)
    } else {
        None
    };
    // SAFETY: close the handle we opened.
    unsafe {
        let _ = IcmpCloseHandle(handle);
    }
    rtt
}

/// Ping one host, returning the round-trip ms or `None` (down/unresolvable). Blocking.
#[cfg(target_os = "windows")]
fn ping_host(host: &str) -> Option<f64> {
    icmp_ping(resolve_ipv4(host)?, PING_TIMEOUT_MS)
}

#[cfg(not(target_os = "windows"))]
fn ping_host(_host: &str) -> Option<f64> {
    None
}

/// Run the demand-gated ping poller until the app exits. Idle (no pings, just a cheap lock-and-check)
/// while no Ping widget is mounted. Each mounted host is pinged concurrently on a blocking thread so a
/// slow/unreachable host never stalls the others or the runtime.
pub async fn run_ping_source<R: Runtime>(app: AppHandle<R>) {
    let timings = app.state::<crate::timings::SubsystemTimings>();
    let mut ticker = tokio::time::interval(INTERVAL);
    loop {
        ticker.tick().await;

        let hosts = {
            let active: State<ActiveSensors> = app.state();
            let g = active.0.lock().unwrap_or_else(|e| e.into_inner());
            hosts_from_active(&g)
        };
        if hosts.is_empty() {
            continue;
        }

        // Ping every host concurrently on blocking threads (ICMP is wait, not CPU).
        let mut tasks = Vec::with_capacity(hosts.len());
        for host in hosts {
            tasks.push(tokio::task::spawn_blocking(move || {
                let rtt = ping_host(&host);
                (host, rtt)
            }));
        }

        let ts = now_ms();
        let mut batch = Vec::new();
        for t in tasks {
            if let Ok((host, rtt)) = t.await {
                batch.extend(samples_for(&host, rtt, ts));
            }
        }
        if !batch.is_empty() {
            // The CPU cost here is just building + emitting the batch (the wait happened above).
            let _t = timings.start("plugin.ping");
            let _ = app.emit(TELEMETRY_EVENT, &batch);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active(entries: &[(&str, &[&str])]) -> HashMap<String, HashSet<String>> {
        entries
            .iter()
            .map(|(label, ids)| {
                (
                    label.to_string(),
                    ids.iter().map(|s| s.to_string()).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn host_of_strips_prefix_and_suffix_even_with_dotted_ips() {
        assert_eq!(host_of("net.ping.1.1.1.1.ms"), Some("1.1.1.1"));
        assert_eq!(host_of("net.ping.8.8.8.8.up"), Some("8.8.8.8"));
        assert_eq!(
            host_of("net.ping.cloudflare.com.ms"),
            Some("cloudflare.com")
        );
        assert_eq!(host_of("net.ping..ms"), None); // empty host
        assert_eq!(host_of("net.down"), None);
        assert_eq!(host_of("*"), None);
    }

    #[test]
    fn hosts_from_active_dedupes_sorts_and_ignores_wildcard() {
        let a = active(&[
            (
                "studio",
                &["*", "net.ping.1.1.1.1.ms", "net.ping.1.1.1.1.up"],
            ),
            ("main", &["net.ping.8.8.8.8.ms", "cpu.total"]),
        ]);
        assert_eq!(hosts_from_active(&a), vec!["1.1.1.1", "8.8.8.8"]);
        // No ping sensors → nothing to ping (the wildcard alone names no host).
        assert!(hosts_from_active(&active(&[("studio", &["*", "cpu.total"])])).is_empty());
    }

    #[test]
    fn samples_for_reachable_and_down() {
        let up = samples_for("1.1.1.1", Some(12.0), 5);
        assert_eq!(up.len(), 2);
        assert_eq!(up[0].sensor, "net.ping.1.1.1.1.up");
        assert_eq!(up[1].sensor, "net.ping.1.1.1.1.ms");
        let val = |s: &SensorSample| serde_json::to_value(s).unwrap()["value"]["value"].clone();
        assert_eq!(val(&up[0]), 1.0);
        assert_eq!(val(&up[1]), 12.0);

        let down = samples_for("1.1.1.1", None, 5);
        assert_eq!(down.len(), 1);
        assert_eq!(down[0].sensor, "net.ping.1.1.1.1.up");
        assert_eq!(val(&down[0]), 0.0);
    }
}
