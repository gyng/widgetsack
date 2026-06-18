// A small live preview of a palette entry, for the Add-palette hover popover (Tier 2). Renders EITHER
// a single widget TYPE (its createWidget defaults) OR an arbitrary tree (a library def's `child` or a
// template's `tree()`), through the real FlowNode + WidgetHost against a seeded telemetry hub — so the
// preview matches how it renders on the canvas, theme tokens and all. A tree is drawn at its native
// size and scaled to fit the box. Self-sourcing / bespoke widgets that need the backend (now-playing,
// spectrum, HA…) just render their idle state here, which still previews their chrome.
import { useMemo } from 'react';
import { createTelemetryHub, type SensorSample, type TelemetryHub } from '../core/telemetry';
import { createWidget } from '../core/widget';
import { leaf, type LayoutNode, type WidgetInstance } from '../core/layoutTree';
import { TelemetryHubContext } from './telemetryContext';
import WidgetHost from './WidgetHost';
import FlowNode, { type RenderLeaf } from './FlowNode';

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

type Props = {
	// One of: a widget type (single meter) OR a tree (def/template) with its native size.
	type?: string;
	node?: LayoutNode;
	size?: { w: number; h: number };
	w?: number; // preview box
	h?: number;
};

export default function WidgetPreview({ type, node, size, w = 200, h = 120 }: Props) {
	const hub = useMemo(() => seedHub(Date.now()), []);
	// Normalise to a (tree, native-size) pair: a type becomes a one-leaf tree at the box size (scale 1);
	// a def/template tree keeps its authored size and is scaled to fit.
	const { tree, nat } = useMemo<{ tree: LayoutNode | null; nat: { w: number; h: number } }>(() => {
		if (type) {
			const inst = createWidget(type, `preview-${type}`);
			inst.rect = { x: 0, y: 0, w, h };
			return { tree: leaf(inst), nat: { w, h } };
		}
		if (node && size) return { tree: node, nat: size };
		return { tree: null, nat: { w, h } };
	}, [type, node, size, w, h]);

	if (!tree) return null;
	const scale = Math.min(w / nat.w, h / nat.h, 1);
	const renderLeaf: RenderLeaf = (lf, id) => (
		<WidgetHost flow hub={hub} instance={lf.unit as WidgetInstance} domId={id} selectId={id} />
	);

	return (
		<div style={{ position: 'relative', width: w, height: h, overflow: 'hidden' }}>
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
				<TelemetryHubContext.Provider value={hub}>
					<FlowNode node={tree} parentKind="col" renderLeaf={renderLeaf} fill />
				</TelemetryHubContext.Provider>
			</div>
		</div>
	);
}
