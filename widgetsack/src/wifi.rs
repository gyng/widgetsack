//! Wi-Fi link detail — SSID / signal / PHY generation / channel for the connected wireless interface,
//! via the WLAN API (`WlanOpenHandle` → `WlanEnumInterfaces` → `WlanQueryInterface`). Complements the
//! adapter/link-speed sensors in `sensors.rs` (`net.linkspeed.*` / `net.adapter`). Demand-gated on
//! `net.wifi.*` — the WLAN handle is only opened when a Wi-Fi widget is mounted. No Wi-Fi / not
//! connected → no samples (the widget shows "—").
//!
//! Emitted ids (gated): `net.wifi.ssid` (text), `net.wifi.signal` (% 0–100), `net.wifi.rssi` (dBm),
//! `net.wifi.rx` / `net.wifi.tx` (Mbps link rate), `net.wifi.band` (text), `net.wifi.channel` (number),
//! `net.wifi.phy` (text — 802.11 generation).
//!
//! Outer-ring adapter: the pure decode seams (`rssi_from_quality`, `band_from_channel`, `phy_label`,
//! `ssid_to_string`, `wifi_samples_from`) hold the logic + tests; the WLAN calls live at the edge.

use crate::sensors::SensorSample;

/// The connected interface's decoded Wi-Fi facts (raw numbers, before sample-shaping). Public so the
/// Windows reader and the pure sample-builder share it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WifiInfo {
    pub ssid: String,
    /// 0–100 signal quality (Windows' `wlanSignalQuality`).
    pub quality: u32,
    pub channel: u32,
    /// Link rates in kbps (Windows' `ulRxRate` / `ulTxRate`).
    pub rx_kbps: u32,
    pub tx_kbps: u32,
    /// `DOT11_PHY_TYPE` ordinal.
    pub phy: u32,
}

/// Map Windows' 0–100 signal quality to an approximate RSSI in dBm: the documented linear scale where
/// 0% = −100 dBm and 100% = −50 dBm. Pure.
fn rssi_from_quality(quality: u32) -> i32 {
    (quality.min(100) as i32) / 2 - 100
}

/// Best-effort frequency band from the channel number. 6 GHz reuses low channel numbers, so this can't
/// be perfectly disambiguated from the channel alone — 2.4 GHz (1–14) and 5 GHz (32–177) are reliable;
/// anything else is left blank (the channel number is always shown as the source of truth). Pure.
fn band_from_channel(ch: u32) -> &'static str {
    match ch {
        1..=14 => "2.4 GHz",
        32..=177 => "5 GHz",
        _ => "",
    }
}

/// `DOT11_PHY_TYPE` ordinal → 802.11 generation letter. Pure. Unknown/legacy types yield "".
fn phy_label(phy: u32) -> &'static str {
    match phy {
        4 => "a",
        5 => "b",
        6 => "g",
        7 => "n",
        8 => "ac",
        9 => "ad",
        10 => "ax",
        11 => "be",
        _ => "",
    }
}

/// Decode a `DOT11_SSID` byte buffer (not NUL-terminated) to a String. Pure.
fn ssid_to_string(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Build the `net.wifi.*` samples from decoded interface facts. Pure seam — fully unit-tested.
pub fn wifi_samples_from(info: &WifiInfo, ts: u64) -> Vec<SensorSample> {
    let mut out = Vec::new();
    if !info.ssid.is_empty() {
        out.push(SensorSample::text("net.wifi.ssid", ts, info.ssid.clone()));
    }
    out.push(SensorSample::scalar(
        "net.wifi.signal",
        ts,
        f64::from(info.quality.min(100)),
    ));
    out.push(SensorSample::scalar(
        "net.wifi.rssi",
        ts,
        f64::from(rssi_from_quality(info.quality)),
    ));
    // kbps → Mbps for display (Wi-Fi link rates read in Mbps).
    out.push(SensorSample::scalar(
        "net.wifi.rx",
        ts,
        f64::from(info.rx_kbps) / 1000.0,
    ));
    out.push(SensorSample::scalar(
        "net.wifi.tx",
        ts,
        f64::from(info.tx_kbps) / 1000.0,
    ));
    if info.channel > 0 {
        out.push(SensorSample::scalar(
            "net.wifi.channel",
            ts,
            f64::from(info.channel),
        ));
        let band = band_from_channel(info.channel);
        if !band.is_empty() {
            out.push(SensorSample::text("net.wifi.band", ts, band));
        }
    }
    let phy = phy_label(info.phy);
    if !phy.is_empty() {
        out.push(SensorSample::text("net.wifi.phy", ts, phy));
    }
    out
}

/// Read the connected wireless interface's Wi-Fi facts via the WLAN API. `None` when there's no
/// wireless interface, none is connected, or any call fails.
#[cfg(target_os = "windows")]
fn read_wifi() -> Option<WifiInfo> {
    use std::ptr::null_mut;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::NetworkManagement::WiFi::{
        WLAN_CONNECTION_ATTRIBUTES, WLAN_INTERFACE_INFO_LIST, WlanCloseHandle, WlanEnumInterfaces,
        WlanFreeMemory, WlanOpenHandle, WlanQueryInterface, wlan_interface_state_connected,
        wlan_intf_opcode_channel_number, wlan_intf_opcode_current_connection,
    };

    const WLAN_API_VERSION_2_0: u32 = 2;

    unsafe {
        let mut negotiated = 0u32;
        let mut handle = HANDLE::default();
        // SAFETY: opens a WLAN client handle; closed below on every path.
        if WlanOpenHandle(WLAN_API_VERSION_2_0, None, &mut negotiated, &mut handle) != 0 {
            return None;
        }

        let mut list_ptr: *mut WLAN_INTERFACE_INFO_LIST = null_mut();
        // SAFETY: fills `list_ptr` with a WlanFreeMemory-owned interface list.
        let info = if WlanEnumInterfaces(handle, None, &mut list_ptr) == 0 && !list_ptr.is_null() {
            let list = &*list_ptr;
            let ifaces = std::slice::from_raw_parts(
                list.InterfaceInfo.as_ptr(),
                list.dwNumberOfItems as usize,
            );
            let mut found = None;
            for iface in ifaces {
                if iface.isState != wlan_interface_state_connected {
                    continue;
                }
                let mut size = 0u32;
                let mut data: *mut core::ffi::c_void = null_mut();
                // SAFETY: queries the current-connection attributes; `data` is WlanFreeMemory-owned.
                if WlanQueryInterface(
                    handle,
                    &iface.InterfaceGuid,
                    wlan_intf_opcode_current_connection,
                    None,
                    &mut size,
                    &mut data,
                    None,
                ) == 0
                    && !data.is_null()
                {
                    let conn = &*(data as *const WLAN_CONNECTION_ATTRIBUTES);
                    let assoc = &conn.wlanAssociationAttributes;
                    let len =
                        (assoc.dot11Ssid.uSSIDLength as usize).min(assoc.dot11Ssid.ucSSID.len());
                    let mut wifi = WifiInfo {
                        ssid: ssid_to_string(&assoc.dot11Ssid.ucSSID[..len]),
                        quality: assoc.wlanSignalQuality,
                        channel: 0,
                        rx_kbps: assoc.ulRxRate,
                        tx_kbps: assoc.ulTxRate,
                        phy: assoc.dot11PhyType.0 as u32,
                    };
                    // Channel is a separate opcode (a bare DWORD).
                    let mut csize = 0u32;
                    let mut cdata: *mut core::ffi::c_void = null_mut();
                    if WlanQueryInterface(
                        handle,
                        &iface.InterfaceGuid,
                        wlan_intf_opcode_channel_number,
                        None,
                        &mut csize,
                        &mut cdata,
                        None,
                    ) == 0
                        && !cdata.is_null()
                    {
                        wifi.channel = *(cdata as *const u32);
                        WlanFreeMemory(cdata as _);
                    }
                    WlanFreeMemory(data as _);
                    found = Some(wifi);
                    break;
                }
            }
            found
        } else {
            None
        };

        if !list_ptr.is_null() {
            WlanFreeMemory(list_ptr as _);
        }
        // SAFETY: close the handle opened above.
        let _ = WlanCloseHandle(handle, None);
        info
    }
}

/// Sample the connected Wi-Fi interface (Windows). Empty off-Windows / when not on Wi-Fi.
#[cfg(target_os = "windows")]
pub fn wifi_samples(ts: u64) -> Vec<SensorSample> {
    match read_wifi() {
        Some(info) => wifi_samples_from(&info, ts),
        None => Vec::new(),
    }
}

#[cfg(not(target_os = "windows"))]
pub fn wifi_samples(_ts: u64) -> Vec<SensorSample> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rssi_maps_quality_linearly() {
        assert_eq!(rssi_from_quality(0), -100);
        assert_eq!(rssi_from_quality(100), -50);
        assert_eq!(rssi_from_quality(50), -75);
        assert_eq!(rssi_from_quality(200), -50); // clamped
    }

    #[test]
    fn band_and_phy_decode() {
        assert_eq!(band_from_channel(6), "2.4 GHz");
        assert_eq!(band_from_channel(149), "5 GHz");
        assert_eq!(band_from_channel(0), "");
        assert_eq!(phy_label(7), "n");
        assert_eq!(phy_label(8), "ac");
        assert_eq!(phy_label(10), "ax");
        assert_eq!(phy_label(99), "");
    }

    #[test]
    fn ssid_decodes_bytes() {
        assert_eq!(ssid_to_string(b"MyWiFi"), "MyWiFi");
        assert_eq!(ssid_to_string(&[]), "");
    }

    #[test]
    fn samples_carry_the_expected_ids_and_conversions() {
        let info = WifiInfo {
            ssid: "Home".into(),
            quality: 80,
            channel: 36,
            rx_kbps: 866_000, // 866 Mbps
            tx_kbps: 433_000,
            phy: 8, // ac
        };
        let s = wifi_samples_from(&info, 3);
        let val = |id: &str| {
            serde_json::to_value(s.iter().find(|x| x.sensor == id).unwrap()).unwrap()["value"]["value"]
                .clone()
        };
        assert_eq!(val("net.wifi.ssid"), "Home");
        assert_eq!(val("net.wifi.signal"), 80.0);
        assert_eq!(val("net.wifi.rssi"), -60.0);
        assert_eq!(val("net.wifi.rx"), 866.0); // kbps → Mbps
        assert_eq!(val("net.wifi.channel"), 36.0);
        assert_eq!(val("net.wifi.band"), "5 GHz");
        assert_eq!(val("net.wifi.phy"), "ac");
    }

    #[test]
    fn empty_ssid_and_zero_channel_are_omitted() {
        let s = wifi_samples_from(&WifiInfo::default(), 0);
        assert!(s.iter().all(|x| x.sensor != "net.wifi.ssid"));
        assert!(s.iter().all(|x| x.sensor != "net.wifi.channel"));
        // signal / rssi / rx / tx are always present.
        assert!(s.iter().any(|x| x.sensor == "net.wifi.signal"));
    }
}
