// A small live preview of a palette entry, for the Add-palette hover popover (Tier 2). Renders EITHER
// a single widget TYPE (its createWidget defaults) OR an arbitrary tree (a library def's `child` or a
// template's `tree()`), through the real FlowNode + WidgetHost against a seeded telemetry hub — so the
// preview matches how it renders on the canvas, theme tokens and all. A tree is drawn at its native
// size and scaled to fit the box. Self-sourcing / bespoke widgets that need the backend (now-playing,
// spectrum, AI…) use offline specimens. Previews never acquire a device or contact a provider.
import { useId, useMemo, useState } from 'react';
import { createTelemetryHub, type SensorSample, type TelemetryHub } from '../core/telemetry';
import { createWidget, getMeta } from '../core/widget';
import { container, leaf, type LayoutNode, type WidgetInstance } from '../core/layoutTree';
import { TelemetryHubContext } from './telemetryContext';
import WidgetHost from './WidgetHost';
import FlowNode, { type RenderLeaf } from './FlowNode';
import { assembleStyles } from '../core/style';
import StyleLayer from './StyleLayer';
import PreviewSample, { needsOfflinePreview } from './PreviewSample';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// Seed the common sensors so data-bound meters (gauge/sparkline/cpu/text/…) look representative.
// Mirrors ThemePreview's seed, broadened (gpu/net-up/swap/battery) since the palette previews any type.
function seedHub(now: number): TelemetryHub {
	const hub = createTelemetryHub();
	const series = (sensor: string, gen: (i: number) => number, n = 40): void => {
		const batch: SensorSample[] = [];
		for (let i = 0; i < n; i++)
			batch.push({ sensor, ts_ms: now - (n - i) * 1000, value: { kind: 'scalar', value: gen(i) } });
		hub.ingestBatch(batch);
	};
	series('cpu.total', (i) => clamp(46 + 22 * Math.sin(i * 0.4) + 8 * Math.sin(i * 0.9), 3, 98));
	series('mem.used', (i) => clamp(55 + 15 * Math.sin(i * 0.3), 20, 90));
	series('net.down', (i) => 1_400_000 + 1_300_000 * Math.abs(Math.sin(i * 0.5)));
	series('net.up', (i) => 300_000 + 500_000 * Math.abs(Math.sin(i * 0.6)));
	series('gpu.util', (i) => clamp(40 + 30 * Math.sin(i * 0.5), 2, 99));
	// Per-core series so the Cpu widget (which discovers cpu.core.* from the hub) has a grid to draw.
	for (let c = 0; c < 8; c++)
		series(`cpu.core.${c}`, (i) => clamp(28 + 45 * Math.abs(Math.sin(i * 0.3 + c)), 2, 99));
	const points: Record<string, number> = {
		'mem.used': 61,
		'swap.used': 12,
		'gpu.util': 57,
		'gpu.vram.used': 5_400_000_000,
		'gpu.vram.total': 8_000_000_000,
		'battery.percent': 82,
		'net.up': 480_000,
		'net.down': 2_600_000,
		'gpu.vram': 64,
		'gpu.temp': 61,
		'gpu.fan': 42,
		'gpu.power': 175,
		'gpu.clock.core': 2400,
		'disk.C.used.pct': 74,
		'disk.C.used': 760_000_000_000,
		'disk.C.total': 1_024_000_000_000,
		'host.uptime': 91000,
		'proc.cpu.top.pct': 18,
		'proc.watch.chrome.exe.running': 1,
		'proc.watch.chrome.exe.cpu': 18,
		'proc.watch.chrome.exe.mem': 900_000_000,
		'proc.watch.chrome.exe.count': 4,
		'weather.temp': 21,
		'weather.apparent': 22,
		'weather.humidity': 64,
		'weather.wind': 12,
		'weather.code': 2,
		'weather.is_day': 1,
		'weather.high': 24,
		'weather.low': 18,
		'weather.uv': 4,
		'weather.air.aqi': 32,
		'weather.air.pm25': 8,
		'weather.air.pm10': 14,
		'net.wifi.signal': 82,
		'net.wifi.rssi': -59,
		'net.wifi.rx': 866,
		'net.wifi.tx': 433,
		'net.wifi.channel': 44,
		'net.ping.1.1.1.1.up': 1,
		'net.ping.1.1.1.1.ms': 12,
		'recyclebin.items': 12,
		'recyclebin.bytes': 320_000_000,
		'stocks.AAPL.price': 215,
		'stocks.AAPL.change': 2.5,
		'stocks.NVDA.price': 215,
		'stocks.NVDA.change': 2.5
	};
	for (const [sensor, value] of Object.entries(points))
		hub.ingest({ sensor, ts_ms: now, value: { kind: 'scalar', value } });
	for (const [sensor, value] of Object.entries({
		'ha.status': 'connected',
		'weather.status': 'configured',
		'weather.unit': 'C',
		'gpu.name': 'Sample GPU',
		'proc.cpu.top.name': 'chrome.exe',
		'net.wifi.ssid': 'Home Wi-Fi',
		'net.wifi.band': '5 GHz',
		'net.wifi.phy': 'ax',
		'battery.state': 'discharging',
		'stocks.NVDA.currency': 'USD',
		'stocks.NVDA.state': 'ready',
		'weather.sun.rise': '2026-10-12T06:30',
		'weather.sun.set': '2026-10-12T18:45'
	})) {
		hub.ingest({ sensor, ts_ms: now, value: { kind: 'text', value } });
	}
	const samples: Record<string, unknown> = {
		'stocks.NVDA.series': [210, 211, 209, 213, 215],
		'agenda.list': [
			{
				summary: 'Design review',
				start: new Date(now + 3_600_000).toISOString(),
				allDay: false,
				location: 'Room 2'
			}
		],
		'rss.list': [
			{
				title: 'A new dashboard idea',
				link: 'https://example.invalid',
				date: new Date(now).toISOString()
			}
		],
		'net.conn.list': [
			{ proc: 'browser.exe', pid: 1234, established: 8, listening: 0, public: 4, remotes: [] }
		]
	};
	for (const [sensor, value] of Object.entries(samples))
		hub.ingest({ sensor, ts_ms: now, value: { kind: 'json', value } });
	for (const type of [
		'sensor',
		'binary_sensor',
		'light',
		'switch',
		'fan',
		'climate',
		'cover',
		'lock',
		'scene',
		'input'
	]) {
		const state =
			type === 'sensor'
				? '22'
				: type === 'climate'
					? 'heat'
					: type === 'cover'
						? 'open'
						: type === 'lock'
							? 'locked'
							: 'on';
		hub.ingest({
			sensor: `preview.ha.${type}`,
			ts_ms: now,
			value: {
				kind: 'json',
				value: {
					state,
					attributes: {
						friendly_name: 'Living room',
						unit_of_measurement: type === 'sensor' ? '°C' : '',
						brightness: 180,
						supported_features: 63,
						temperature: 22,
						current_temperature: 21,
						hvac_modes: ['off', 'heat', 'cool'],
						percentage: 60,
						current_position: 75,
						options: ['Home', 'Away']
					}
				}
			}
		});
	}
	return hub;
}

type Props = {
	// One of: a widget type (single meter) OR a tree (def/template) with its native size.
	type?: string;
	node?: LayoutNode;
	size?: { w: number; h: number };
	w?: number; // preview box
	h?: number;
};

export default function WidgetPreview({ type, node, size, w = 200, h = 120 }: Props) {
	// Seed the demo clock once at mount via lazy state, keeping Date.now() (impure) out of render.
	const [now] = useState(() => Date.now());
	const hub = useMemo(() => seedHub(now), [now]);
	// Normalise to a (tree, native-size) pair: a type becomes a one-leaf tree at its default size;
	// a def/template tree keeps its authored size and is scaled to fit.
	const { tree, nat } = useMemo<{ tree: LayoutNode | null; nat: { w: number; h: number } }>(() => {
		if (type) {
			const inst = createWidget(type, `preview-${type}`);
			const size =
				type === 'spacer' ? { w: 240, h: 100 } : (getMeta(type)?.defaultSize ?? { w, h });
			inst.rect = { x: 0, y: 0, ...size };
			if (type.startsWith('ha.')) inst.sensor = `preview.${type}`;
			return { tree: leaf(inst), nat: size };
		}
		if (node && size) return { tree: node, nat: size };
		return { tree: null, nat: { w, h } };
	}, [type, node, size, w, h]);

	const previewId = useId();
	const css = tree
		? assembleStyles({
				monitor: { root: container('preview-style-root', 'col', [tree]), floating: [] }
			})
		: '';
	if (!tree) return null;
	const scale = Math.min(w / nat.w, h / nat.h, 1);
	const renderLeaf: RenderLeaf = (lf, id) =>
		needsOfflinePreview((lf.unit as WidgetInstance).type) ? (
			<div data-id={id} data-w={id} style={{ width: '100%', height: '100%' }}>
				<PreviewSample type={(lf.unit as WidgetInstance).type} />
			</div>
		) : (
			<WidgetHost
				flow
				hub={hub}
				instance={lf.unit as WidgetInstance}
				domId={id}
				selectId={id}
				previewMode
			/>
		);

	return (
		<div
			data-preview={previewId}
			style={{ position: 'relative', width: w, height: h, overflow: 'hidden' }}
		>
			<div
				style={{
					position: 'absolute',
					top: 0,
					left: 0,
					width: nat.w,
					height: nat.h,
					transform: scale !== 1 ? `scale(${scale})` : undefined,
					transformOrigin: 'top left'
				}}
			>
				<StyleLayer
					css={css
						.replaceAll('[data-w=', `[data-preview="${previewId}"] [data-w=`)
						.replaceAll('[data-group]', `[data-preview="${previewId}"] [data-group]`)}
				/>
				<TelemetryHubContext.Provider value={hub}>
					<FlowNode node={tree} parentKind="col" renderLeaf={renderLeaf} fill />
				</TelemetryHubContext.Provider>
			</div>
		</div>
	);
}
