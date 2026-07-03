// A live theme preview (molecule) for the Themes section: a handful of representative meters rendered
// through the real WidgetHost against a small, self-contained telemetry hub. It carries no theme
// styling of its own — the meters inherit the global `:root` tokens + overrides that StyleLayer
// injects into the studio document, so editing a token (or switching theme) restyles the preview
// live, exactly as it will the overlay. Kept dependency-light (no spectrum/now-playing) so it needs
// no extra context. Co-located test in ThemePreview.test.tsx.
import { useMemo, useState } from 'react';
import { createTelemetryHub, type SensorSample, type TelemetryHub } from '../core/telemetry';
import { createWidget } from '../core/widget';
import type { WidgetInstance } from '../core/layout';
import { TelemetryHubContext } from './telemetryContext';
import WidgetHost from './WidgetHost';
import './ThemePreview.css';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// A deterministic-enough seed: a wavy CPU history (for the gauge + sparkline), a bursty net history
// (for the rate text), and a couple of point values. `now` only orders the ring buffer.
function seedHub(now: number): TelemetryHub {
	const hub = createTelemetryHub();
	const series = (sensor: string, gen: (i: number) => number, n = 40): void => {
		const batch: SensorSample[] = [];
		for (let i = 0; i < n; i++)
			batch.push({ sensor, ts_ms: now - (n - i) * 1000, value: { kind: 'scalar', value: gen(i) } });
		hub.ingestBatch(batch);
	};
	series('cpu.total', (i) => clamp(46 + 22 * Math.sin(i * 0.4) + 8 * Math.sin(i * 0.9), 3, 98));
	series('net.down', (i) => 1_400_000 + 1_300_000 * Math.abs(Math.sin(i * 0.5)));
	hub.ingest({ sensor: 'mem.used', ts_ms: now, value: { kind: 'scalar', value: 61 } });
	return hub;
}

function build(
	type: string,
	id: string,
	w: number,
	h: number,
	sensor?: string,
	config?: Record<string, unknown>
): WidgetInstance {
	const inst = createWidget(type, id);
	if (sensor) inst.sensor = sensor;
	if (config) inst.config = { ...inst.config, ...config };
	inst.rect = { x: 0, y: 0, w, h };
	return inst;
}

export default function ThemePreview() {
	// new Date()/Date.now() is fine in a live component (only the screenshot gallery freezes the clock);
	// seeded once at mount via lazy state so the render body stays pure.
	const [now] = useState(() => Date.now());
	const { hub, items } = useMemo(() => {
		return {
			hub: seedHub(now),
			items: [
				build('gauge', 'tp-gauge', 88, 88, 'cpu.total', { label: 'CPU', unit: '%' }),
				build('bar', 'tp-bar', 150, 26, 'mem.used', { label: 'MEM' }),
				build('sparkline', 'tp-spark', 150, 44, 'cpu.total', { fill: true }),
				build('text', 'tp-text', 150, 24, 'net.down', { format: 'rate', label: '↓ ' }),
				build('clock', 'tp-clock', 150, 36, undefined, { format: 'HH:mm:ss' }),
				build('button', 'tp-btn', 90, 38, undefined, { label: 'tap' })
			]
		};
	}, [now]);

	return (
		<div className="theme-preview" aria-label="theme preview">
			<TelemetryHubContext.Provider value={hub}>
				{items.map((inst) => (
					<div key={inst.id} className="tp-cell" style={{ minHeight: inst.rect.h }}>
						<WidgetHost hub={hub} instance={inst} />
					</div>
				))}
			</TelemetryHubContext.Provider>
		</div>
	);
}
