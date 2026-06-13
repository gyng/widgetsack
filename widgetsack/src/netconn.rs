//! Active TCP connections — the "what's talking to the internet" panel, for security peace of mind.
//! One `GetExtendedTcpTable(OWNER_PID)` snapshot per tick (cheap, no admin), mapped to owning process
//! names via a single Toolhelp snapshot. Demand-gated on `net.conn.*`: nothing runs unless a
//! connections widget is mounted. This is OBSERVABILITY, not an IDS — it surfaces unusual outbound
//! connections (which process is holding sockets to which public IP) so *you* notice them; it can't
//! label a connection malicious.
//!
//! Emitted ids (gated):
//! - `net.conn.list` (Json): per-process rows `{ proc, pid, established, listening, public, remotes }`,
//!   busiest (most public talkers) first, capped. `remotes` are distinct public `ip:port` endpoints.
//! - `net.conn.established` / `net.conn.listening` / `net.conn.public` (scalars): machine-wide totals.
//!
//! IPv4 only for now (the v4 TCP table) — IPv6 is a follow-up; the pure seams below are addr-family
//! agnostic where it's free. Reverse-DNS and GeoIP are deliberately omitted: rDNS means live network
//! round-trips and GeoIP would ship your connection IPs to a third party, undermining the point.

use std::collections::HashMap;

use serde::Serialize;

use crate::sensors::{SensorSample, SensorValue};

/// At most this many process rows in `net.conn.list` (busiest first), and this many distinct remote
/// endpoints per row — keeps the JSON payload small and the UI legible.
const MAX_ROWS: usize = 20;
const MAX_REMOTES: usize = 6;

/// MIB_TCP_STATE values we care about (the rest — TIME_WAIT, SYN_SENT, … — are transient noise here).
const STATE_LISTEN: i32 = 2;
const STATE_ESTAB: i32 = 5;

/// One raw row from the OS TCP table, decoded into plain integers so the aggregation below is pure
/// and testable without Win32. `*_addr` are the raw little-endian `in_addr` DWORDs; `*_port` are the
/// raw (network-byte-order, low-word) DWORDs straight from `MIB_TCPROW_OWNER_PID`.
#[derive(Clone, Copy, Debug)]
pub struct RawConn {
    pub pid: u32,
    pub state: i32,
    pub remote_addr: u32,
    pub remote_port: u32,
}

/// One process's connection summary — a row in `net.conn.list`. camelCase on the wire (mirrors
/// `ProcConn` in `client/src/lib/core/netconn.ts`).
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcConn {
    pub proc: String,
    pub pid: u32,
    /// Established (active) outbound/inbound connections owned by this process.
    pub established: u32,
    /// Sockets this process has in LISTEN state (accepting inbound).
    pub listening: u32,
    /// Of `established`, how many go to a PUBLIC (non-private) remote IP — the "peace of mind" number.
    pub public: u32,
    /// Distinct public remote `ip:port` endpoints (capped), so the UI can show *where* it's talking.
    pub remotes: Vec<String>,
}

/// Machine-wide totals emitted as scalars alongside the list.
#[derive(Debug, Default, PartialEq)]
pub struct ConnTotals {
    pub established: u32,
    pub listening: u32,
    pub public: u32,
}

/// The four octets of a raw `in_addr` DWORD. The DWORD holds the address in network byte order; on a
/// little-endian host (every Windows target) its little-endian bytes ARE the octets a.b.c.d.
fn octets(addr: u32) -> [u8; 4] {
    addr.to_le_bytes()
}

/// Host-order TCP port from the raw DWORD: the port sits in the low word in network (big-endian)
/// byte order, so swap it. e.g. raw `0x5000` → 80.
fn host_port(dw_port: u32) -> u16 {
    u16::from_be((dw_port & 0xffff) as u16)
}

/// `a.b.c.d:port` for a raw addr DWORD + raw port DWORD.
fn fmt_endpoint(addr: u32, dw_port: u32) -> String {
    let [a, b, c, d] = octets(addr);
    format!("{a}.{b}.{c}.{d}:{}", host_port(dw_port))
}

/// Is this remote address PRIVATE (so a connection to it isn't "talking to the internet")? Covers
/// loopback, the RFC-1918 ranges, link-local, CGNAT (100.64/10), multicast/reserved and the
/// unspecified 0.0.0.0 (a wildcard bind, not a real remote).
fn is_private_v4(addr: u32) -> bool {
    let [a, b, _, _] = octets(addr);
    a == 0                                   // 0.0.0.0 unspecified / listen-any
        || a == 10                           // 10/8
        || a == 127                          // loopback
        || (a == 172 && (16..=31).contains(&b)) // 172.16/12
        || (a == 192 && b == 168)            // 192.168/16
        || (a == 169 && b == 254)            // link-local
        || (a == 100 && (64..=127).contains(&b)) // CGNAT 100.64/10
        || a >= 224 // multicast (224/4) + reserved/broadcast (240/4, 255.255.255.255)
}

/// True when an established connection's remote is a real public Internet host.
fn is_public_remote(addr: u32) -> bool {
    !is_private_v4(addr)
}

/// Fold raw TCP rows into per-process summaries + machine-wide totals. Pure — the OS read and the
/// pid→name snapshot happen at the edge. Rows are sorted busiest-first (most public talkers, then
/// most established, then name) and capped to `MAX_ROWS`; per-row remotes are distinct + capped.
pub fn aggregate(conns: &[RawConn], names: &HashMap<u32, String>) -> (Vec<ProcConn>, ConnTotals) {
    struct Agg {
        established: u32,
        listening: u32,
        public: u32,
        remotes: Vec<String>,
    }
    let mut by_pid: HashMap<u32, Agg> = HashMap::new();
    let mut totals = ConnTotals::default();

    for c in conns {
        let entry = by_pid.entry(c.pid).or_insert(Agg {
            established: 0,
            listening: 0,
            public: 0,
            remotes: Vec::new(),
        });
        match c.state {
            STATE_ESTAB => {
                entry.established += 1;
                totals.established += 1;
                if is_public_remote(c.remote_addr) {
                    entry.public += 1;
                    totals.public += 1;
                    let ep = fmt_endpoint(c.remote_addr, c.remote_port);
                    if entry.remotes.len() < MAX_REMOTES && !entry.remotes.contains(&ep) {
                        entry.remotes.push(ep);
                    }
                }
            }
            STATE_LISTEN => {
                entry.listening += 1;
                totals.listening += 1;
            }
            _ => {}
        }
    }

    let mut rows: Vec<ProcConn> = by_pid
        .into_iter()
        // Drop pids with nothing established or listening (e.g. only transient states seen).
        .filter(|(_, a)| a.established > 0 || a.listening > 0)
        .map(|(pid, a)| ProcConn {
            proc: names.get(&pid).cloned().unwrap_or_else(|| format!("pid {pid}")),
            pid,
            established: a.established,
            listening: a.listening,
            public: a.public,
            remotes: a.remotes,
        })
        .collect();
    rows.sort_by(|x, y| {
        y.public
            .cmp(&x.public)
            .then(y.established.cmp(&x.established))
            .then(x.proc.to_lowercase().cmp(&y.proc.to_lowercase()))
    });
    rows.truncate(MAX_ROWS);
    (rows, totals)
}

/// Build the `net.conn.*` samples from raw rows + a pid→name map. Pure seam — fully unit-tested.
pub fn build_samples(ts: u64, conns: &[RawConn], names: &HashMap<u32, String>) -> Vec<SensorSample> {
    let (rows, totals) = aggregate(conns, names);
    let list = serde_json::to_value(&rows).unwrap_or(serde_json::Value::Null);
    vec![
        SensorSample {
            sensor: "net.conn.list".into(),
            ts_ms: ts,
            value: SensorValue::Json(list),
        },
        SensorSample::scalar("net.conn.established", ts, f64::from(totals.established)),
        SensorSample::scalar("net.conn.listening", ts, f64::from(totals.listening)),
        SensorSample::scalar("net.conn.public", ts, f64::from(totals.public)),
    ]
}

/// Read the IPv4 TCP table with owning PIDs via `GetExtendedTcpTable`. Two-call pattern (size, then
/// fill). `None`/empty on any failure. No admin needed.
#[cfg(target_os = "windows")]
fn read_tcp_table() -> Vec<RawConn> {
    use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
    };

    const AF_INET: u32 = 2;
    let mut size: u32 = 0;
    // First call sizes the buffer (expects ERROR_INSUFFICIENT_BUFFER).
    // SAFETY: a sizing call — null table pointer, size-out only.
    let rc = unsafe {
        GetExtendedTcpTable(None, &mut size, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0)
    };
    if rc != ERROR_INSUFFICIENT_BUFFER.0 || size == 0 {
        return Vec::new();
    }
    let mut buf = vec![0u8; size as usize];
    // SAFETY: `buf` is `size` bytes; GetExtendedTcpTable fills it with a MIB_TCPTABLE_OWNER_PID.
    let rc = unsafe {
        GetExtendedTcpTable(
            Some(buf.as_mut_ptr().cast()),
            &mut size,
            false,
            AF_INET,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if rc != NO_ERROR.0 {
        return Vec::new();
    }
    // SAFETY: on success `buf` begins with a MIB_TCPTABLE_OWNER_PID whose `table` is a flexible array
    // of `dwNumEntries` rows within the same allocation.
    let table = unsafe { &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID) };
    let n = table.dwNumEntries as usize;
    let rows = unsafe { std::slice::from_raw_parts(table.table.as_ptr(), n) };
    rows.iter()
        .map(|r| RawConn {
            pid: r.dwOwningPid,
            state: r.dwState as i32,
            remote_addr: r.dwRemoteAddr,
            remote_port: r.dwRemotePort,
        })
        .collect()
}

/// pid → executable name via a single Toolhelp process snapshot (cheap; no per-process handle). Empty
/// on failure — rows then fall back to `pid N`.
#[cfg(target_os = "windows")]
fn process_names() -> HashMap<u32, String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut map = HashMap::new();
    // SAFETY: snapshot of all processes; we CloseHandle it below.
    let Ok(snap) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return map;
    };
    let mut pe = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: `pe.dwSize` is set; First/Next fill `pe` until they return Err (end of list).
    if unsafe { Process32FirstW(snap, &mut pe) }.is_ok() {
        loop {
            let len = pe.szExeFile.iter().position(|&c| c == 0).unwrap_or(pe.szExeFile.len());
            let name = String::from_utf16_lossy(&pe.szExeFile[..len]);
            if !name.is_empty() {
                map.insert(pe.th32ProcessID, name);
            }
            if unsafe { Process32NextW(snap, &mut pe) }.is_err() {
                break;
            }
        }
    }
    // SAFETY: close the snapshot handle we opened.
    unsafe {
        let _ = CloseHandle(snap);
    }
    map
}

/// Sample the active connections (Windows). Empty off-Windows.
#[cfg(target_os = "windows")]
pub fn connection_samples(ts: u64) -> Vec<SensorSample> {
    let conns = read_tcp_table();
    let names = process_names();
    build_samples(ts, &conns, &names)
}

#[cfg(not(target_os = "windows"))]
pub fn connection_samples(_ts: u64) -> Vec<SensorSample> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(pairs: &[(u32, &str)]) -> HashMap<u32, String> {
        pairs.iter().map(|(p, n)| (*p, n.to_string())).collect()
    }

    // Build a raw u32 in_addr from octets (the inverse of `octets`), matching the on-host layout.
    fn addr(a: u8, b: u8, c: u8, d: u8) -> u32 {
        u32::from_le_bytes([a, b, c, d])
    }
    // Build the raw (network-byte-order, low-word) port DWORD from a host port.
    fn port(p: u16) -> u32 {
        u32::from(p.to_be())
    }

    #[test]
    fn octets_and_port_decode_network_order() {
        assert_eq!(octets(addr(127, 0, 0, 1)), [127, 0, 0, 1]);
        assert_eq!(host_port(port(80)), 80);
        assert_eq!(host_port(port(44321)), 44321);
        assert_eq!(fmt_endpoint(addr(1, 2, 3, 4), port(443)), "1.2.3.4:443");
    }

    #[test]
    fn private_ranges_are_not_public() {
        for a in [
            addr(10, 0, 0, 5),
            addr(192, 168, 1, 1),
            addr(172, 16, 0, 1),
            addr(172, 31, 255, 1),
            addr(127, 0, 0, 1),
            addr(169, 254, 0, 1),
            addr(100, 64, 0, 1),
            addr(0, 0, 0, 0),
            addr(224, 0, 0, 1),
        ] {
            assert!(is_private_v4(a), "expected private: {:?}", octets(a));
            assert!(!is_public_remote(a));
        }
        // Just outside the private ranges → public.
        assert!(is_public_remote(addr(8, 8, 8, 8)));
        assert!(is_public_remote(addr(172, 15, 0, 1)));
        assert!(is_public_remote(addr(172, 32, 0, 1)));
        assert!(is_public_remote(addr(1, 1, 1, 1)));
    }

    #[test]
    fn aggregate_counts_and_ranks_by_public_talkers() {
        let conns = vec![
            // chrome: two established to public + one to a private LAN host.
            RawConn { pid: 100, state: STATE_ESTAB, remote_addr: addr(8, 8, 8, 8), remote_port: port(443) },
            RawConn { pid: 100, state: STATE_ESTAB, remote_addr: addr(1, 1, 1, 1), remote_port: port(443) },
            RawConn { pid: 100, state: STATE_ESTAB, remote_addr: addr(192, 168, 1, 9), remote_port: port(445) },
            // svchost: a listener only.
            RawConn { pid: 200, state: STATE_LISTEN, remote_addr: addr(0, 0, 0, 0), remote_port: port(135) },
            // foo: one established to a public host.
            RawConn { pid: 300, state: STATE_ESTAB, remote_addr: addr(93, 184, 216, 34), remote_port: port(80) },
            // transient state is ignored.
            RawConn { pid: 300, state: 4 /* SYN_SENT */, remote_addr: addr(5, 5, 5, 5), remote_port: port(80) },
        ];
        let (rows, totals) = aggregate(&conns, &names(&[(100, "chrome.exe"), (200, "svchost.exe")]));

        assert_eq!(totals, ConnTotals { established: 4, listening: 1, public: 3 });
        // chrome (2 public) ranks before foo (1 public) before svchost (0 public, listener).
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].proc, "chrome.exe");
        assert_eq!(rows[0].established, 3);
        assert_eq!(rows[0].public, 2);
        assert_eq!(rows[0].remotes, vec!["8.8.8.8:443", "1.1.1.1:443"]);
        // Unknown pid 300 falls back to "pid 300".
        assert_eq!(rows[1].proc, "pid 300");
        assert_eq!(rows[1].public, 1);
        // The listener row carries no established/public but is still shown.
        assert_eq!(rows[2].proc, "svchost.exe");
        assert_eq!(rows[2].listening, 1);
        assert_eq!(rows[2].established, 0);
    }

    #[test]
    fn build_samples_emits_list_and_totals() {
        let conns = vec![RawConn {
            pid: 1,
            state: STATE_ESTAB,
            remote_addr: addr(8, 8, 4, 4),
            remote_port: port(443),
        }];
        let s = build_samples(7, &conns, &names(&[(1, "a.exe")]));
        assert_eq!(s[0].sensor, "net.conn.list");
        assert!(matches!(s[0].value, SensorValue::Json(_)));
        assert_eq!(s[0].ts_ms, 7);
        let json = serde_json::to_value(&s[0].value).unwrap();
        // Tagged-enum wire shape: { kind: "json", value: [ … ] }.
        assert_eq!(json["kind"], "json");
        assert_eq!(json["value"][0]["proc"], "a.exe");
        assert_eq!(json["value"][0]["public"], 1);

        assert_eq!(s[1].sensor, "net.conn.established");
        assert_eq!(s[2].sensor, "net.conn.listening");
        assert_eq!(s[3].sensor, "net.conn.public");
    }

    #[test]
    fn remotes_are_distinct_and_capped() {
        // Many established to the SAME public endpoint → one distinct remote, public count still counts all.
        let mut conns = Vec::new();
        for _ in 0..10 {
            conns.push(RawConn {
                pid: 1,
                state: STATE_ESTAB,
                remote_addr: addr(20, 20, 20, 20),
                remote_port: port(443),
            });
        }
        let (rows, _) = aggregate(&conns, &names(&[(1, "x.exe")]));
        assert_eq!(rows[0].public, 10);
        assert_eq!(rows[0].remotes, vec!["20.20.20.20:443"]); // de-duped
    }
}
