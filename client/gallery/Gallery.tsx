// The screenshot gallery: one capturable "stage" per registered widget type, plus a curated demo
// sidebar that mirrors the desktop-widget layout. Every widget renders through the real WidgetHost
// with a seeded telemetry hub, so what you see is exactly what the app draws. The Playwright rig
// (scripts/screenshots.mjs) screenshots each `[data-shot]` element and reads `window.__GALLERY__`
// for the per-widget metadata used to generate the docs pages.

import { useEffect } from 'react';
// Register the plugin widgets (HA, now-playing, MQTT, stocks/Ticker — deliberately not the AI
// Provider) so they appear in the gallery, exactly as Canvas.tsx does in the app via
// registerBuiltinPlugins(). Must run before paletteItems().
import { registerHomeAssistantPlugin } from '../src/lib/widgets/plugins/home-assistant';
import { registerNowPlayingPlugin } from '../src/lib/widgets/plugins/now-playing';
import { registerMqttPlugin } from '../src/lib/widgets/plugins/mqtt';
import { registerStocksPlugin } from '../src/lib/widgets/plugins/stocks';
import { registerWeatherPlugin } from '../src/lib/widgets/plugins/weather';
import { TelemetryHubContext } from '../src/lib/widgets/telemetryContext';
import { SpectrumContext } from '../src/lib/widgets/spectrumContext';
import WidgetHost from '../src/lib/widgets/WidgetHost';
import StyleLayer from '../src/lib/widgets/StyleLayer';
import { paletteItems, getMeta } from '../src/lib/widgets/registry';
import { createWidget } from '../src/lib/core/widget';
import { scopeCss } from '../src/lib/core/style';
import { DEFAULT_TOKENS, tokensToCss } from '../src/lib/core/tokens';
import type { WidgetInstance } from '../src/lib/core/layout';
import type { TelemetryHub } from '../src/lib/core/telemetry';
import { fakeSpectrum, makeHub } from './seed';
import './gallery.css';

registerHomeAssistantPlugin();
registerNowPlayingPlugin();
registerMqttPlugin();
registerStocksPlugin();
registerWeatherPlugin();

const hub: TelemetryHub = makeHub();

// A tiny same-origin page for the iframe widget (normalizeUrl only accepts http/https, so a data:
// URL is rejected). Served by the gallery's own dev server next to this entry.
const IFRAME_DEMO = `${location.origin}/gallery/iframe-demo.html`;

// Per-type tweaks so each widget renders a representative, good-looking demo. Anything not listed
// uses the meta's own defaults (sensor + config + size).
const OVERRIDES: Record<string, { sensor?: string; config?: Record<string, unknown> }> = {
	gauge: { sensor: 'cpu.total', config: { label: 'CPU', unit: '%' } },
	bar: { sensor: 'mem.used', config: { label: 'MEM' } },
	sparkline: { sensor: 'gpu.util', config: { seconds: 60, fill: true } },
	text: { sensor: 'net.down', config: { format: 'rate', label: '↓ ' } },
	cpu: { config: { mode: 'cores', cols: 6 } },
	iframe: { config: { url: IFRAME_DEMO } },
	ticker: { config: { symbol: 'NVDA' } },
	'ha.sensor': { sensor: 'demo.temperature' },
	'ha.light': { sensor: 'demo.light' },
	'ha.climate': { sensor: 'demo.climate' }
};

function buildInstance(
	type: string,
	id: string,
	overrides: Partial<WidgetInstance> = {}
): WidgetInstance {
	const inst = createWidget(type, id);
	const tweak = OVERRIDES[type];
	if (tweak?.sensor) inst.sensor = tweak.sensor;
	if (tweak?.config) inst.config = { ...inst.config, ...tweak.config };
	const merged: WidgetInstance = { ...inst, ...overrides };
	if (overrides.config) merged.config = { ...inst.config, ...overrides.config };
	merged.rect = overrides.rect ?? { x: 0, y: 0, w: inst.rect.w, h: inst.rect.h };
	return merged;
}

// The widget types to showcase, in palette order.
const TYPES = paletteItems();
const widgetInstances = TYPES.map((t) => buildInstance(t.type, `w-${t.type}`));

// A curated demo layout (hand-placed) — the marketing shot. Landscape (four columns) with generous
// padding/gaps so it sits well in the README and shows the widget breadth: A = at-a-glance readouts
// (clock, CPU arc + GPU circle gauges, net rates, uptime, a countdown timer), B = graphs (per-core
// CPU, MEM/VRAM, net throughput, a disk pips gauge, audio spectrum), C = cards (now-playing + stock
// ticker), D = analog clock + Home
// Assistant sensor/climate/light. 24px outer pad, 24px column gaps; 900×380 to match the README's
// other shots. Sized to fill the .demo-panel (gallery.css). The date clock carries instance css to
// step its fixed 30px value down — at 30px a long date wraps into the gauges below.
const DEMO: WidgetInstance[] = [
	// Column A (x 24, w 168) — at-a-glance: clock, CPU/GPU gauges, network rates, uptime, timer.
	buildInstance('clock', 'd-time', {
		rect: { x: 24, y: 24, w: 168, h: 34 },
		config: { format: 'HH:mm' }
	}),
	buildInstance('clock', 'd-date', {
		rect: { x: 24, y: 64, w: 168, h: 18 },
		config: { format: 'dddd D MMMM' },
		css: '.np-clock .value { font-size: 14px; letter-spacing: 0.4px; opacity: 0.85; }'
	}),
	buildInstance('gauge', 'd-g-cpu', {
		rect: { x: 24, y: 100, w: 78, h: 78 },
		sensor: 'cpu.total',
		config: { label: 'CPU', unit: '%' }
	}),
	buildInstance('gauge', 'd-g-gpu', {
		rect: { x: 114, y: 100, w: 78, h: 78 },
		sensor: 'gpu.util',
		config: { label: 'GPU', unit: '%', style: 'circle' }
	}),
	buildInstance('text', 'd-net-down-t', {
		rect: { x: 24, y: 198, w: 168, h: 18 },
		sensor: 'net.down',
		config: { format: 'rate', label: '↓ ', color: 'rgb(218, 237, 226)' }
	}),
	buildInstance('text', 'd-net-up-t', {
		rect: { x: 24, y: 220, w: 168, h: 18 },
		sensor: 'net.up',
		config: { format: 'rate', label: '↑ ', color: 'rgb(119, 196, 211)' }
	}),
	buildInstance('text', 'd-uptime', {
		rect: { x: 24, y: 248, w: 168, h: 18 },
		sensor: 'host.uptime',
		config: { format: 'duration', label: 'up ', color: 'rgb(160, 188, 198)' }
	}),
	buildInstance('timer', 'd-timer', {
		rect: { x: 24, y: 286, w: 168, h: 70 }
	}),
	// Column B (x 216, w 300) — graphs: per-core CPU, MEM/VRAM, net throughput, audio spectrum.
	buildInstance('cpu', 'd-cpu', {
		rect: { x: 216, y: 24, w: 300, h: 60 },
		config: { mode: 'cores', cols: 12 }
	}),
	buildInstance('bar', 'd-mem', {
		rect: { x: 216, y: 104, w: 300, h: 14 },
		sensor: 'mem.used',
		config: { label: 'MEM' }
	}),
	buildInstance('bar', 'd-vram', {
		rect: { x: 216, y: 126, w: 300, h: 14 },
		sensor: 'gpu.vram',
		config: { label: 'VRAM' }
	}),
	buildInstance('sparkline', 'd-net-down', {
		rect: { x: 216, y: 160, w: 300, h: 38 },
		sensor: 'net.down',
		config: { histogram: true, color: 'rgb(218, 237, 226)' }
	}),
	buildInstance('sparkline', 'd-net-up', {
		rect: { x: 216, y: 202, w: 300, h: 38 },
		sensor: 'net.up',
		config: { histogram: true, color: 'rgb(119, 196, 211)' }
	}),
	buildInstance('gauge', 'd-disk', {
		rect: { x: 216, y: 248, w: 300, h: 22 },
		sensor: 'disk.C.used.pct',
		config: { label: 'DISK', unit: '%', style: 'pips', direction: 'ltr', pips: 20 }
	}),
	buildInstance('spectrum', 'd-spectrum', {
		rect: { x: 216, y: 288, w: 300, h: 68 }
	}),
	// Column C (x 540, w 184) — cards: now-playing + stock ticker.
	buildInstance('nowplaying', 'd-np', { rect: { x: 540, y: 24, w: 184, h: 192 } }),
	buildInstance('ticker', 'd-ticker', {
		rect: { x: 540, y: 248, w: 184, h: 100 },
		config: { symbol: 'NVDA' }
	}),
	// Column D (x 748, w 128) — analog clock + Home Assistant sensor/climate/light.
	buildInstance('analogclock', 'd-analog', {
		rect: { x: 757, y: 24, w: 110, h: 110 },
		config: { showTicks: true }
	}),
	buildInstance('ha.sensor', 'd-ha-temp', {
		rect: { x: 748, y: 156, w: 128, h: 38 },
		sensor: 'demo.temperature'
	}),
	buildInstance('ha.climate', 'd-ha-climate', {
		rect: { x: 748, y: 204, w: 128, h: 82 },
		sensor: 'demo.climate'
	}),
	buildInstance('ha.light', 'd-ha-light', {
		rect: { x: 748, y: 300, w: 128, h: 48 },
		sensor: 'demo.light'
	})
];

// One stylesheet: the default design tokens (:root) + each instance's seeded css (mostly NowPlaying)
// scoped to its [data-w="<id>"] host, exactly as the app assembles it.
const allInstances = [...widgetInstances, ...DEMO];
// Gallery-only: the default now-playing title/artist is sized for a large widget (52px); shrink it so
// it reads well at the small gallery + demo sizes (the app keeps the full size).
const NP_GALLERY_CSS = `[data-type="nowplaying"] .np-title { font-size: 19px; font-weight: 600; line-height: 1.25; }
[data-type="nowplaying"] .np-artist { font-size: 15px; line-height: 1.3; opacity: 0.72; }`;
const styleCss = [
	tokensToCss(DEFAULT_TOKENS, ':root'),
	...allInstances.map((i) => scopeCss(i.css, `[data-w="${i.id}"]`)),
	NP_GALLERY_CSS
]
	.filter(Boolean)
	.join('\n');

function Stage({ inst, w, h }: { inst: WidgetInstance; w: number; h: number }) {
	return (
		<div className="stage" data-shot={`widget-${inst.type}`} style={{ width: w, height: h }}>
			<WidgetHost hub={hub} instance={inst} />
		</div>
	);
}

export default function Gallery() {
	useEffect(() => {
		// Expose per-widget metadata for the docs generator (read via page.evaluate).
		(window as unknown as { __GALLERY__: unknown }).__GALLERY__ = {
			widgets: TYPES.map((t) => {
				const meta = getMeta(t.type);
				return {
					type: t.type,
					label: t.label,
					binds: meta?.binds ?? 'scalar',
					defaultSensor: meta?.defaultSensor ?? null,
					defaultSize: meta?.defaultSize ?? null,
					defaultConfig: meta?.defaultConfig ?? {},
					configFields: (meta?.configFields ?? []).map((f) => ({
						key: f.key,
						label: f.label,
						kind: f.kind,
						help: 'help' in f ? f.help ?? null : null
					}))
				};
			})
		};
		// Signal "ready to shoot" once a frame has painted.
		requestAnimationFrame(() => document.body.setAttribute('data-ready', 'true'));
	}, []);

	return (
		<TelemetryHubContext.Provider value={hub}>
			<SpectrumContext.Provider value={fakeSpectrum}>
				<StyleLayer css={styleCss} />
				<h1>widgetsack — widget gallery</h1>

				<section className="grid">
					{widgetInstances.map((inst) => {
						const meta = getMeta(inst.type);
						const natW = meta?.defaultSize?.w ?? inst.rect.w;
						const natH = meta?.defaultSize?.h ?? inst.rect.h;
						// Cap the thumbnail width so an oversized widget (e.g. the 600×400 zone) can't overflow
						// its grid column and overlap a neighbour's shot. ≤224 keeps the stage (content + 36px
						// pad) inside the grid's 260px minimum track. Proportional; the instance is resized to
						// match so the widget renders AT the shown size (not its full rect, which would overlap).
						const scale = Math.min(1, 224 / natW);
						const w = Math.round(natW * scale);
						const h = Math.round(natH * scale);
						const shown = scale < 1 ? { ...inst, rect: { ...inst.rect, w, h } } : inst;
						return (
							<figure key={inst.type} className="cell">
								<Stage inst={shown} w={w} h={h} />
								<figcaption>{meta?.label ?? inst.type}</figcaption>
							</figure>
						);
					})}
				</section>

				<h2>Demo layout</h2>
				<div className="demo-panel" data-shot="demo">
					{DEMO.map((inst) => (
						<WidgetHost key={inst.id} hub={hub} instance={inst} />
					))}
				</div>
			</SpectrumContext.Provider>
		</TelemetryHubContext.Provider>
	);
}
