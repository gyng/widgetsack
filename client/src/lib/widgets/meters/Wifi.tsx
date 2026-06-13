// Wi-Fi meter (presentational, props-only). Multi-sensor: the meta binds net.wifi.* via a sensors map;
// WidgetHost passes the snapshot. Shows the SSID + a signal-bar icon, with an optional detail line
// (band · channel · 802.11 generation · RSSI · link rate). No Wi-Fi / not connected → "Not connected".
// BARE DOM; styled in Wifi.css via --np-* tokens.
import type { CSSProperties } from 'react';
import type { SensorState } from '../../core/telemetry';
import { signalBars, wifiLevel } from '../../core/wifi';
import './Wifi.css';

type Props = {
	sensors?: Record<string, SensorState>;
	showDetail?: boolean;
	color?: string;
};

const scalar = (s?: SensorState): number | null =>
	s?.value && s.value.kind === 'scalar' ? s.value.value : null;
const textOf = (s?: SensorState): string | null =>
	s?.value && s.value.kind === 'text' ? s.value.value : null;

export default function Wifi({ sensors = {}, showDetail = true, color }: Props) {
	const ssid = textOf(sensors.ssid);
	const signal = scalar(sensors.signal);
	const rssi = scalar(sensors.rssi);
	const rx = scalar(sensors.rx);
	const band = textOf(sensors.band);
	const channel = scalar(sensors.channel);
	const phy = textOf(sensors.phy);

	const bars = signalBars(signal);
	const level = wifiLevel(signal);
	const connected = ssid != null && ssid.length > 0;
	const vars = color ? ({ '--wf-accent': color } as CSSProperties) : undefined;

	const detail = [
		band || null,
		channel != null ? `ch ${channel}` : null,
		phy ? `802.11${phy}` : null,
		rssi != null ? `${Math.round(rssi)} dBm` : null,
		rx != null && rx > 0 ? `${Math.round(rx)} Mbps` : null
	].filter(Boolean) as string[];

	return (
		<div className="wifi np-wifi" style={vars} data-level={level}>
			<div className="wf-main">
				<span className="wf-bars" role="img" aria-label={`signal ${bars} of 4`}>
					{[1, 2, 3, 4].map((b) => (
						<span key={b} className="wf-bar" data-on={b <= bars || undefined} />
					))}
				</span>
				<span className="wf-ssid" data-part="value" title={ssid ?? ''}>
					{connected ? ssid : 'Not connected'}
				</span>
			</div>
			{showDetail && connected && detail.length > 0 && (
				<div className="wf-detail" data-part="detail">
					{detail.map((d, i) => (
						<span key={i}>{d}</span>
					))}
				</div>
			)}
		</div>
	);
}
