// Pure helpers for the Wi-Fi widget. No React/DOM — unit-tested. The backend (widgetsack/src/wifi.rs)
// emits net.wifi.{ssid,signal,rssi,rx,tx,band,channel,phy}; the meta binds them via a sensors map and
// the meter renders signal bars + detail. This just turns the 0–100 quality into a bar count / label.

export type WifiLevel = 'none' | 'weak' | 'ok' | 'good' | 'strong';

const LEVELS: WifiLevel[] = ['none', 'weak', 'ok', 'good', 'strong'];

/** 0..4 signal bars from a 0–100 signal quality (null / ≤0 → 0). */
export function signalBars(quality: number | null): number {
	if (quality == null || quality <= 0) return 0;
	if (quality >= 80) return 4;
	if (quality >= 60) return 3;
	if (quality >= 40) return 2;
	return 1;
}

/** A coarse signal label (drives the accent), derived from the bar count. */
export function wifiLevel(quality: number | null): WifiLevel {
	return LEVELS[signalBars(quality)];
}
