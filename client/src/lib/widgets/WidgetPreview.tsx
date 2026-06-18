// A small live preview of ONE widget TYPE, for the Add-palette hover popover (Tier 2). Generalises
// ThemePreview: seed a self-contained telemetry hub with demo data so data-bound meters (gauge /
// sparkline / text / cpu …) look alive, instantiate the type via createWidget (its defaults), and
// render it through the real WidgetHost — so the preview matches exactly how the widget renders on the
// canvas, theme tokens and all. Self-sourcing / bespoke widgets that need the backend (now-playing,
// spectrum, HA…) simply render their idle/empty state here, which still previews their chrome.
import { useMemo } from 'react';
import { createTelemetryHub, type SensorSample, type TelemetryHub } from '../core/telemetry';
import { createWidget } from '../core/widget';
import { TelemetryHubContext } from './telemetryContext';
import WidgetHost from './WidgetHost';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// Seed the common sensors so most meters show something representative. Series for the history-based
// meters (gauge/sparkline/cpu), point values for the scalar text/bars. Mirrors ThemePreview's seed,
// broadened a little (gpu/net-up/swap/battery) since the palette previews every type.
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
	const points: Record<string, number> = {
		'mem.used': 61,
		'swap.used': 12,
		'gpu.util': 57,
		'gpu.vram.used': 5_400_000_000,
		'gpu.vram.total': 8_000_000_000,
		'battery.percent': 82,
		'net.up': 480_000,
		'net.down': 2_600_000
	};
	for (const [sensor, value] of Object.entries(points))
		hub.ingest({ sensor, ts_ms: now, value: { kind: 'scalar', value } });
	return hub;
}

export default function WidgetPreview({
	type,
	w = 200,
	h = 120
}: {
	type: string;
	w?: number;
	h?: number;
}) {
	const { hub, inst } = useMemo(() => {
		const now = Date.now();
		const i = createWidget(type, `preview-${type}`);
		i.rect = { x: 0, y: 0, w, h };
		return { hub: seedHub(now), inst: i };
	}, [type, w, h]);

	// position:relative box at the preview size; WidgetHost positions its meter within it.
	return (
		<div style={{ position: 'relative', width: w, height: h }}>
			<TelemetryHubContext.Provider value={hub}>
				<WidgetHost hub={hub} instance={inst} />
			</TelemetryHubContext.Provider>
		</div>
	);
}
