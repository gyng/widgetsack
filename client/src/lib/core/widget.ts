// The standard widget API (Phase 8a). A widget TYPE is described by a framework-agnostic
// `WidgetMeta` (defaults + config schema + how it binds to a sensor); the React component
// is attached in the widgets layer (registry.tsx), keeping the metas framework-agnostic.
// Built-in meters register their metas here on load, so `createWidget` is pure + testable
// without the UI layer. Plugins add more via `registerMeta` (see widgets/registry.tsx
// `registerWidget`). Co-located vitest tests in widget.test.ts.

import type { WidgetInstance } from './layout';
import { topProcessSensors } from './topProcess';
import { pingSensors } from './ping';

// A typed config field, so the inspector can render a real input instead of raw JSON. `help` is a
// one-line description surfaced in the inspector; `default` is the field's own reset value (falls
// back to the widget type's defaultConfig[key] when omitted) — together these make the config UI
// fully self-describing from the widget meta (item: "config should be ui driven").
type FieldMeta = { help?: string; default?: unknown };
export type ConfigField =
	| ({
			key: string;
			label: string;
			kind: 'number';
			min?: number;
			max?: number;
			step?: number;
	  } & FieldMeta)
	| ({ key: string; label: string; kind: 'text' } & FieldMeta)
	| ({ key: string; label: string; kind: 'color' } & FieldMeta)
	| ({ key: string; label: string; kind: 'toggle' } & FieldMeta)
	// `catalog` names a runtime-populated option set (e.g. 'audioOutputs') the inspector fills from a
	// backend list; when set, `options` is the static fallback (usually empty).
	| ({
			key: string;
			label: string;
			kind: 'select';
			options: string[];
			catalog?: string;
	  } & FieldMeta)
	// A formula field (Phase: expressions). `result` is what the evaluated value coerces to — 'number'
	// for a numeric prop, 'text' for a string template. The evaluated value overrides the meter prop
	// named `target` (defaults to `key`), winning over the bound sensor + static config. See
	// lib/formula/* (sandboxed QuickJS) and lib/core/textTemplate.ts.
	| ({
			key: string;
			label: string;
			kind: 'expr';
			result: 'number' | 'text';
			target?: string;
	  } & FieldMeta)
	// A macro field: an ordered list of {domain, service, data?} action calls (core/macro.ts), edited
	// as rows in the inspector and run in sequence when the widget is pressed. The value is a
	// MacroAction[]; the side-effecting dispatch lives in Canvas.onWidgetControl (domain 'macro').
	| ({ key: string; label: string; kind: 'macro' } & FieldMeta);

export type SensorKind = 'scalar' | 'series' | 'text' | 'json' | 'none';

export type WidgetMeta = {
	type: string;
	binds?: SensorKind; // what sensor kind it reads ('none' = self-sourcing)
	label?: string; // palette name
	// Palette group header — without it the Add palette is a wall of ~20 same-weight chips.
	// Plugin widgets default to the plugin's name at registration (widgets/plugin.ts).
	category?: string;
	description?: string; // one-line "what it is / what it's for" (palette tooltip + generated docs)
	defaultSensor?: string;
	defaultSize?: { w: number; h: number };
	defaultConfig?: Record<string, unknown>;
	defaultCss?: string; // seeded into a new instance's editable `css` (the default LOOK lives here,
	// not in the component, so it's fully restylable). The component ships structure only.
	configFields?: ConfigField[];
	// Config-driven multi-sensor binding: derive the NAMED sensor ids this type reads from an
	// instance's config (pure — data in, data out). The wiring layer (WidgetHost) subscribes to each
	// id and passes the meter a `sensors` prop (name → live SensorState), so multi-sensor meters
	// stay props-only (AGENTS.md §6) — e.g. the stock ticker maps `stocks.<symbol>.*` per field.
	sensors?: (config: Record<string, unknown>) => Record<string, string>;
	// CSS-flow sizing hint. An 'intrinsic' meter has a natural CONTENT size (text — clock/text), so a
	// `basis:'content'` leaf shrink-wraps to its rendered content (e.g. a date "4" + month "JUNE" each
	// fit their text and sit adjacent). FILL meters (gauge/sparkline/analogclock: width:100% with no
	// intrinsic size) omit this so 'content' keeps their authored box instead of collapsing to 0.
	intrinsic?: boolean;
	interactive?: boolean; // catches clicks in passive mode (per-widget click-through)
};

// The Now Playing widget's ENTIRE stylesheet (layout + look), seeded into each new instance's
// editable `css` — the component itself is pure DOM (no <style>), so this is fully restylable.
// Scoped to the widget at injection (assembleStyles), so these selectors target the component's
// parts. The progress bar, timers and controls are display:none here (un-hide via css).
export const NOWPLAYING_DEFAULT_CSS = `.np-nowplaying {
	display: flex;
	flex-direction: column;
	gap: var(--np-gap, 4px);
	width: 100%;
	height: 100%;
	overflow: hidden;
	font-family: var(--np-font-display, 'Bahnschrift', 'Arial Narrow', sans-serif);
	color: var(--np-fg, rgb(255, 255, 255));
	/* Play/pause fade (ported from the original widget): dim when not playing, full on hover. */
	transition: opacity 0.2s ease-in;
}
.np-nowplaying[data-playing='false'] {
	opacity: 0.2;
}
.np-nowplaying[data-playing='false']:hover {
	opacity: 1;
}
/* Crossfade: album-art layers overlap in the stack; on a track change the new cover fades in over
   the previous one (removed once it has loaded), so a song change never flashes empty/black. */
.np-thumb-stack {
	position: relative;
	flex: 1 1 0;
	min-height: 0;
	width: 100%;
}
.np-thumb {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	object-fit: contain;
	object-position: left;
	/* Two independent fades: a snappy opacity crossfade (data-loaded) + a slower desaturate-to-grey
	   that marks the previous track's cover as stale the instant the song changes (data-leaving). */
	opacity: 0;
	filter: grayscale(0);
	transition: opacity 0.12s ease-out, filter 0.45s ease-out;
	will-change: opacity, filter;
}
.np-thumb[data-loaded='true'] {
	opacity: 1;
}
/* Song-change cue: the outgoing cover greys out (like the paused dim) — separate from, and slower
   than, the opacity crossfade — while the new track's cover fades in over it in full colour. */
.np-thumb[data-leaving='true'] {
	filter: grayscale(1);
}
.np-title,
.np-artist {
	flex: 0 0 auto;
	font-size: 52px;
	/* >1 so descenders (g, y, p) aren't clipped by the line's overflow:hidden (ellipsis). */
	line-height: 1.2;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
/* Breathing room above the title (separating it from the album art) and below the artist
   (separating it from the widget's bottom edge). Themeable via the --np-*-gap vars. */
.np-title {
	margin-top: var(--np-title-gap, 8px);
}
.np-artist {
	margin-bottom: var(--np-artist-gap, 8px);
}
.np-progress,
.np-times,
.np-controls {
	display: none;
	flex: 0 0 auto;
}
.np-progress {
	height: 3px;
	background: var(--np-track, rgba(255, 255, 255, 0.15));
}
.np-progress-fill {
	height: 100%;
	background: var(--np-accent, rgb(119, 196, 211));
}
.np-times {
	justify-content: space-between;
}
.np-controls {
	gap: 8px;
}`;

const num = (
	key: string,
	label: string,
	extra: { min?: number; max?: number; step?: number } & FieldMeta = {}
): ConfigField => ({ key, label, kind: 'number', ...extra } as ConfigField);
const text = (key: string, label: string, extra: FieldMeta = {}): ConfigField =>
	({ key, label, kind: 'text', ...extra } as ConfigField);
const color = (key: string, label: string, extra: FieldMeta = {}): ConfigField =>
	({ key, label, kind: 'color', ...extra } as ConfigField);
const expr = (
	key: string,
	label: string,
	result: 'number' | 'text',
	extra: { target?: string } & FieldMeta = {}
): ConfigField => ({ key, label, kind: 'expr', result, ...extra } as ConfigField);

// The built-in meters as data (reproduces the old createWidget switch exactly, so the
// default look/behaviour is unchanged). Components are attached in registry.ts.
export const BUILTIN_METAS: WidgetMeta[] = [
	{
		type: 'gauge',
		description:
			'Gauge for one scalar sensor (default 0–100%): arc ring, full circle, linear bar, pips or needle dial.',
		binds: 'scalar',
		label: 'Gauge',
		category: 'Meters',
		defaultSensor: 'cpu.total',
		defaultSize: { w: 110, h: 110 },
		defaultConfig: { label: 'CPU', unit: '%', min: 0, max: 100 },
		configFields: [
			text('label', 'label'),
			text('unit', 'unit', { help: 'suffix after the value, e.g. % or °C' }),
			num('min', 'min', { help: 'value mapped to an empty gauge' }),
			num('max', 'max', { help: 'value mapped to a full gauge' }),
			color('color', 'color'),
			color('track', 'track', { help: 'color of the unfilled arc' }),
			{
				key: 'style',
				label: 'style',
				kind: 'select',
				options: ['arc', 'circle', 'linear', 'pips', 'needle'],
				default: 'arc',
				help: 'arc ring (default), closed circle, linear bar, discrete pips, or analog needle dial'
			},
			{
				key: 'direction',
				label: 'direction',
				kind: 'select',
				options: ['arc', 'ltr', 'rtl', 'btt', 'ttb'],
				default: 'arc',
				help: 'pips + linear styles only: arc keeps pips on the ring; ltr/rtl/btt/ttb lay the bar or pip row along an axis'
			},
			num('pips', 'pips', {
				min: 3,
				max: 40,
				step: 1,
				default: 10,
				help: 'pips style only: number of segments'
			}),
			num('sweep', 'sweep (°)', {
				min: 90,
				max: 360,
				step: 15,
				default: 270,
				help: 'arc/pips/needle styles: arc span in degrees (180 = semicircle); the gap stays centred at the bottom'
			}),
			expr('value', 'value (formula)', 'number', {
				help: 'overrides the sensor, e.g. round(mem.used, 0) or cpu.total / 2'
			}),
			expr('minExpr', 'min (formula)', 'number', { target: 'min' }),
			expr('maxExpr', 'max (formula)', 'number', { target: 'max' })
		]
	},
	{
		type: 'bar',
		description: 'Linear progress bar for one scalar sensor; horizontal or vertical.',
		binds: 'scalar',
		label: 'Bar',
		category: 'Meters',
		defaultSensor: 'mem.used',
		defaultSize: { w: 140, h: 16 },
		defaultConfig: { min: 0, max: 100, label: 'MEM' },
		configFields: [
			text('label', 'label'),
			num('min', 'min', { help: 'value mapped to an empty bar' }),
			num('max', 'max', { help: 'value mapped to a full bar' }),
			{
				key: 'orientation',
				label: 'orientation',
				kind: 'select',
				options: ['horizontal', 'vertical'],
				help: 'fill direction'
			},
			color('color', 'color'),
			color('track', 'track', { help: 'color of the unfilled track' }),
			expr('value', 'value (formula)', 'number', {
				help: 'overrides the sensor, e.g. clamp(cpu.total, 0, 100)'
			}),
			expr('minExpr', 'min (formula)', 'number', { target: 'min' }),
			expr('maxExpr', 'max (formula)', 'number', { target: 'max' })
		]
	},
	{
		type: 'sparkline',
		description: 'Compact line / area / histogram of a sensor history (a time series).',
		binds: 'series',
		label: 'Sparkline',
		category: 'Meters',
		defaultSensor: 'cpu.total',
		defaultSize: { w: 140, h: 30 },
		defaultConfig: { seconds: 60, barGap: 0.2, axis: true },
		configFields: [
			color('color', 'color'),
			{ key: 'fill', label: 'fill', kind: 'toggle', help: 'fill the area under the line' },
			{
				key: 'histogram',
				label: 'histogram (bars)',
				kind: 'toggle',
				help: 'draw bars instead of a line'
			},
			{
				key: 'axis',
				label: 'baseline axis',
				kind: 'toggle',
				help: 'show a baseline axis line under the bars (histogram mode)'
			},
			num('barGap', 'bar gap', {
				min: 0,
				max: 0.9,
				step: 0.05,
				help: 'gap between histogram bars, 0–0.9 of a slot (0 = touching)'
			}),
			num('seconds', 'history (s)', { min: 5, step: 5, help: 'seconds of history to show' }),
			num('lineWidth', 'line width', { min: 0.5, step: 0.5, help: 'stroke thickness (line mode)' })
		]
	},
	{
		type: 'text',
		description:
			'A single value as formatted text (percent / rate / bytes / duration / integer) with an optional label.',
		binds: 'scalar',
		label: 'Text',
		category: 'Meters',
		intrinsic: true, // text meter → basis:'content' shrink-wraps to the rendered value
		defaultSensor: 'net.down',
		defaultSize: { w: 100, h: 18 },
		defaultConfig: { format: 'rate', label: '↓' },
		configFields: [
			text('label', 'label'),
			text('format', 'format', {
				help: 'percent | rate (bytes/s) | bytes (e.g. 16.0 GiB) | duration (uptime) | integer; else raw'
			}),
			color('color', 'color'),
			expr('value', 'value (formula)', 'text', {
				help: 'template: text + {expressions}, e.g. CPU {round(cpu.total)}% · {bytes(mem.used.bytes)}'
			})
		]
	},
	{
		type: 'clock',
		description: 'Date / time clock using a date-fns format pattern (self-sourcing).',
		binds: 'none',
		label: 'Clock',
		category: 'Clocks',
		intrinsic: true, // text meter → basis:'content' shrink-wraps to the rendered string
		defaultSize: { w: 160, h: 40 },
		defaultConfig: { format: 'HH:mm:ss' },
		configFields: [
			text('format', 'format', { help: 'date-fns pattern, e.g. HH:mm:ss or dddd D MMMM' }),
			{
				key: 'locale',
				label: 'locale',
				kind: 'select',
				options: ['en', 'ja', 'zh'],
				help: 'month/day names'
			},
			text('label', 'label'),
			color('color', 'color')
		]
	},
	{
		// Self-sourcing month calendar grid. binds:none; re-reads the date on a slow tick so "today"
		// stays current. The grid (first-day-of-week, continuous spill into next month) is pure
		// (core/calendar.ts); the meter just renders it.
		type: 'calendar',
		description:
			'A month calendar grid: configurable first day of week, optional weekday header, highlights today, and an optional continuous view that spills dimmed into next month (self-sourcing).',
		binds: 'none',
		label: 'Calendar',
		category: 'Clocks',
		defaultSize: { w: 220, h: 200 },
		defaultConfig: {
			firstDay: 'Sunday',
			weekdayHeader: true,
			continuous: false,
			highlightToday: true,
			showTitle: true,
			locale: 'en'
		},
		configFields: [
			{
				key: 'firstDay',
				label: 'first day of week',
				kind: 'select',
				options: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
			},
			{ key: 'weekdayHeader', label: 'weekday header', kind: 'toggle' },
			{
				key: 'continuous',
				label: 'continuous',
				kind: 'toggle',
				help: 'spill dimmed days through the end of next month'
			},
			{ key: 'highlightToday', label: 'highlight today', kind: 'toggle' },
			{ key: 'showTitle', label: 'month title', kind: 'toggle' },
			{
				key: 'locale',
				label: 'locale',
				kind: 'select',
				options: ['en', 'ja', 'zh'],
				help: 'weekday / month names'
			},
			color('color', 'accent')
		]
	},
	{
		// Self-sourcing analog clock (classic face + hands). binds:none; ticks internally.
		type: 'analogclock',
		description: 'Analog clock face with hour / minute / second hands (self-sourcing).',
		binds: 'none',
		label: 'Analog Clock',
		category: 'Clocks',
		defaultSize: { w: 120, h: 120 },
		// Defaults to the minimal Enigma "Icon" look: ring + 3 hands, no ticks/numerals/cap, 1s tick.
		defaultConfig: {
			showSeconds: true,
			showTicks: false,
			showNumbers: false,
			showCap: false,
			updateMs: 1000
		},
		configFields: [
			{ key: 'showSeconds', label: 'second hand', kind: 'toggle' },
			{ key: 'showTicks', label: 'tick marks', kind: 'toggle' },
			{ key: 'showNumbers', label: 'hour numbers', kind: 'toggle' },
			{ key: 'showCap', label: 'centre cap', kind: 'toggle' },
			num('updateMs', 'update (ms)', {
				min: 16,
				step: 50,
				help: 'redraw interval; lower = smoother second hand, higher = lighter'
			}),
			color('color', 'hands/ticks', { help: 'hour + minute hands, ticks, ring' }),
			color('accent', 'second hand'),
			color('face', 'face', { help: 'face fill (default transparent)' })
		]
	},
	{
		// An action button: pressing it runs its `actions` macro (a sequence of {domain,service,data}
		// calls — HA services or media transport) in order. interactive:true so it catches clicks in
		// passive overlay mode (per-widget click-through). With no actions it's an inert label (also
		// the click-through canary). See core/macro.ts + Canvas.onWidgetControl (domain 'macro').
		type: 'button',
		description:
			'Pressable button that runs a macro of {domain, service, data} calls (HA services or media transport).',
		binds: 'none',
		label: 'Button',
		category: 'Utility',
		defaultSize: { w: 90, h: 44 },
		defaultConfig: { label: 'tap', actions: [] },
		interactive: true,
		configFields: [
			text('label', 'label'),
			{
				key: 'actions',
				label: 'actions (macro)',
				kind: 'macro',
				help: 'run these calls in order on press — domain/service like Home Assistant (put entity_id in data), or domain "media" for now-playing transport (playpause/next/previous)'
			}
		]
	},
	{
		// Self-sourcing CPU widget: reads cpu.total + cpu.core.* from the hub (binds:none). Toggles
		// between a combined gauge and a per-core sparkline grid (the classic System skin).
		type: 'cpu',
		description: 'Self-sourcing CPU widget: a per-core sparkline grid or one combined gauge.',
		binds: 'none',
		label: 'CPU',
		category: 'Meters',
		defaultSize: { w: 160, h: 90 },
		defaultConfig: { mode: 'cores', cols: 8, seconds: 30 },
		configFields: [
			{
				key: 'mode',
				label: 'mode',
				kind: 'select',
				options: ['cores', 'combined'],
				help: 'per-core sparkline grid vs one combined gauge'
			},
			num('cols', 'cols (per-core grid)', {
				min: 1,
				help: 'columns in the per-core grid (blank = 8; clamped to the core count)'
			}),
			num('seconds', 'history (s)', { min: 5, step: 5, help: 'seconds of history to show' }),
			{
				key: 'histogram',
				label: 'histogram (bars)',
				kind: 'toggle',
				help: 'draw bars instead of lines'
			},
			num('lineWidth', 'core line width', {
				min: 0.5,
				step: 0.5,
				help: 'per-core stroke thickness'
			}),
			text('label', 'label (combined)'),
			color('color', 'color')
		]
	},
	{
		// Battery indicator (laptops). Multi-sensor (binds:'none') — reads the battery.* family via the
		// `sensors` map; WidgetHost resolves it (useSensorMap) and passes a props-only `sensors` snapshot.
		// A desktop with no battery emits no battery.* samples, so it shows "—".
		type: 'battery',
		description:
			'A battery indicator: charge icon, percent, and charging / time-remaining status (laptops; a desktop without a battery shows "—").',
		binds: 'none',
		sensors: () => ({ percent: 'battery.percent', state: 'battery.state', time: 'battery.time' }),
		label: 'Battery',
		category: 'Meters',
		defaultSize: { w: 150, h: 44 },
		defaultConfig: { showStatus: true },
		configFields: [
			{
				key: 'showStatus',
				label: 'status line',
				kind: 'toggle',
				help: 'show charging / time-remaining under the percent'
			},
			color('color', 'fill colour')
		]
	},
	{
		// GPU panel: card name + a prominent utilisation %, plus whatever NVML reports (temp / VRAM /
		// power / clock / fan). Multi-sensor (binds:'none') — reads the gpu.* family via the `sensors`
		// map. No NVIDIA/NVML → no gpu.* samples, so it shows "—".
		type: 'gpu',
		description:
			'A GPU panel: card name, utilisation %, and the reported temp / VRAM / power / clock / fan (NVIDIA NVML; non-NVIDIA shows "—").',
		binds: 'none',
		sensors: () => ({
			util: 'gpu.util',
			name: 'gpu.name',
			temp: 'gpu.temp',
			vramUsed: 'gpu.vram.used',
			vramTotal: 'gpu.vram.total',
			power: 'gpu.power',
			clock: 'gpu.clock.core',
			fan: 'gpu.fan'
		}),
		label: 'GPU',
		category: 'Meters',
		defaultSize: { w: 200, h: 96 },
		defaultConfig: { showName: true },
		configFields: [
			{ key: 'showName', label: 'card name', kind: 'toggle', help: 'show the GPU model header' },
			text('label', 'name override', { help: 'replace the detected card name' }),
			color('color', 'accent')
		]
	},
	{
		// Self-sourcing storage panel (binds:'none'): a usage bar per volume. Discovers the dynamic
		// `disk.<letter>.*` ids from the hub at runtime (like Cpu's per-core discovery) and signals the
		// demand-gated per-disk enumeration via a `disk._probe` sentinel. Capacity only — bind a
		// Sparkline to `disk.<letter>.read`/`.write` for I/O graphs.
		type: 'disks',
		description:
			'Storage usage: one bar per volume (used %, used/total), auto-discovering your drives. Near-full volumes warn.',
		binds: 'none',
		label: 'Disks',
		category: 'Meters',
		defaultSize: { w: 200, h: 80 },
		defaultConfig: { showBytes: true },
		configFields: [
			{
				key: 'showBytes',
				label: 'show used / total',
				kind: 'toggle',
				help: 'append used/total bytes after the percent'
			},
			color('color', 'accent')
		]
	},
	{
		// The busiest process by CPU / RAM / disk I/O / GPU VRAM — "what's eating my machine".
		// Multi-sensor (binds:'none'): the `sensors` map derives proc.<by>.top.{name,value} from the
		// chosen metric. The backend only samples a metric while its widget is mounted (per-metric
		// demand gating), and GPU additionally needs NVML — no metric is paid for unless shown.
		type: 'topproc',
		description:
			'The busiest process by CPU %, RAM, disk I/O, or GPU VRAM — "what’s eating my machine". Each metric is sampled only while shown.',
		binds: 'none',
		sensors: (config) => topProcessSensors(String(config.by ?? 'cpu')),
		label: 'Top Process',
		category: 'Meters',
		defaultSize: { w: 200, h: 44 },
		defaultConfig: { by: 'cpu' },
		configFields: [
			{
				key: 'by',
				label: 'rank by',
				kind: 'select',
				options: ['cpu', 'mem', 'disk', 'gpu'],
				help: 'CPU %, RAM, disk I/O, or GPU VRAM (GPU needs NVIDIA/NVML)'
			},
			text('label', 'label', { help: 'header (defaults to "Top CPU" etc.)' }),
			color('color', 'accent')
		]
	},
	{
		// Self-sourcing network-connections panel (binds:'none'): per-process active connections +
		// listening ports + how many go to PUBLIC remotes — security peace of mind. Subscribes to the
		// `net.conn.list` JSON sensor (which demand-gates the backend GetExtendedTcpTable snapshot) and
		// reads the net.conn.* totals. Observability, not an IDS.
		type: 'netconn',
		description:
			'Active network connections by process: established + listening counts and how many go to a PUBLIC remote IP — so an unusual outbound connection stands out. Observability, not an IDS.',
		binds: 'none',
		label: 'Connections',
		category: 'Network',
		defaultSize: { w: 240, h: 150 },
		defaultConfig: { showListening: false, maxRows: 8 },
		configFields: [
			{
				key: 'showListening',
				label: 'show listeners',
				kind: 'toggle',
				help: 'include processes that are only LISTENing (accepting inbound), not just active talkers'
			},
			num('maxRows', 'max rows', {
				min: 1,
				max: 20,
				step: 1,
				help: 'how many processes to list (busiest — most public — first)'
			}),
			color('color', 'accent')
		]
	},
	{
		// Ping / "is my internet up?" (binds:'none', multi-sensor): the `sensors` map binds
		// net.ping.<host>.{ms,up} from config.host. Subscribing tells the backend poller which host to
		// ICMP-ping (demand gate), so nothing pings until this widget is mounted.
		type: 'ping',
		description:
			'Ping a host (default 1.1.1.1) and show reachability + round-trip latency — a quick "is my internet up?" light. ICMP, no admin needed.',
		binds: 'none',
		sensors: (config) => pingSensors(String(config.host ?? '1.1.1.1')),
		label: 'Ping',
		category: 'Network',
		intrinsic: true,
		defaultSize: { w: 150, h: 24 },
		defaultConfig: { host: '1.1.1.1', slowMs: 150 },
		configFields: [
			text('host', 'host', { help: 'IP or hostname to ping, e.g. 1.1.1.1 or cloudflare.com' }),
			text('label', 'label', { help: 'override the shown name (defaults to the host)' }),
			num('slowMs', 'slow threshold (ms)', {
				min: 1,
				step: 10,
				help: 'latency at/above this is shown as "slow" (amber)'
			}),
			color('color', 'accent')
		]
	},
	{
		// Self-sourcing audio spectrum (binds:'none'): WASAPI loopback → real FFT in Rust, streamed
		// over a Channel and drawn on a <canvas>. The display bar count is independent of the capture
		// band count (the meter groups bands down), so changing it never reconfigures capture.
		type: 'spectrum',
		description:
			'Self-sourcing audio spectrum (WASAPI loopback FFT): frequency bars or a scrolling spectrogram.',
		binds: 'none',
		label: 'Spectrum',
		category: 'Meters',
		defaultSize: { w: 220, h: 90 },
		defaultConfig: { mode: 'bars', bars: 48, gap: 0.15, device: '', scale: 'log', pips: false },
		configFields: [
			{
				key: 'device',
				label: 'output device',
				kind: 'select',
				options: [],
				catalog: 'audioOutputs',
				help: 'which audio output to visualise (blank = system default)'
			},
			{
				key: 'mode',
				label: 'mode',
				kind: 'select',
				options: ['bars', 'spectrogram'],
				help: 'frequency bars vs a scrolling spectrogram heatmap'
			},
			{
				key: 'scale',
				label: 'frequency scale',
				kind: 'select',
				options: ['log', 'linear'],
				help: 'log spreads the low frequencies (musical, default); linear is even Hz/bar'
			},
			{
				key: 'pips',
				label: 'frequency pips',
				kind: 'toggle',
				help: 'gridline markers at 100 Hz / 1 kHz / 10 kHz'
			},
			num('bars', 'bars', {
				min: 8,
				max: 128,
				step: 1,
				help: 'number of frequency bars (bars mode)'
			}),
			num('gap', 'bar gap', { min: 0, max: 0.9, step: 0.05, help: 'spacing between bars (0..1)' }),
			color('color', 'color', { help: 'bars mode; defaults to the theme accent' })
		]
	},
	{
		// Embedded web page (binds:'none'; no sensor). interactive:true makes the TYPE eligible for
		// passive click-through; the per-instance `interact` config then decides whether it actually
		// catches clicks or passes them through to the desktop (see meters/Iframe.tsx). Suited to
		// self-hosted dashboards (Home Assistant, Grafana) — many public sites refuse framing.
		type: 'iframe',
		description:
			'Embedded web page (self-hosted dashboards); optional click-through interactivity.',
		binds: 'none',
		label: 'Web Frame',
		category: 'Utility',
		defaultSize: { w: 320, h: 240 },
		interactive: true,
		defaultConfig: {
			url: '',
			refresh: 0,
			scroll: false,
			interact: false,
			sandbox: true,
			referrerPolicy: 'no-referrer',
			title: '',
			timeoutMs: 6000
		},
		configFields: [
			text('url', 'url', {
				help: 'bare domains get https://; http:// (LAN) is allowed; javascript:/data: are rejected'
			}),
			num('refresh', 'refresh (s)', {
				min: 0,
				max: 3600,
				step: 5,
				help: 'auto-reload interval in seconds (0 = never); reloads cost CPU/network'
			}),
			{
				key: 'scroll',
				label: 'scroll',
				kind: 'toggle',
				help: 'allow scrolling inside the frame'
			},
			{
				key: 'interact',
				label: 'interactive',
				kind: 'toggle',
				help: 'off: clicks pass through to the desktop; on: the frame catches clicks (passive overlay only — dragging always works in edit mode)'
			},
			{
				key: 'sandbox',
				label: 'sandbox',
				kind: 'toggle',
				help: 'recommended: isolates the page (scripts only, no parent/popups/top-nav). Turn off only for a trusted page needing same-origin features (e.g. a Home Assistant login)'
			},
			{
				key: 'referrerPolicy',
				label: 'referrer',
				kind: 'select',
				options: ['no-referrer', 'origin', 'same-origin'],
				help: 'what Referer the embedded page sees (no-referrer leaks nothing)'
			},
			text('title', 'title', { help: 'accessible label for the frame (screen readers / tooltip)' }),
			num('timeoutMs', 'blocked timeout (ms)', {
				min: 1000,
				max: 30000,
				step: 500,
				help: "how long to wait for a load before showing a 'blocked or unreachable' hint"
			})
		]
	},
	{
		// A landing zone: a screen region foreign app windows snap into. Drawn/sized on the canvas
		// like any widget, but it RENDERS NOTHING on the live overlay (an outline + tag only while
		// editing) — the overlay's DragSnapLayer reads zone widgets to highlight + snap. The optional
		// match rule (matchExe/Class/Title) drives on-demand auto-arrange (core/arrange.ts).
		type: 'zone',
		description:
			'A landing zone: drag a window over it (hold Shift) to snap it here; optional match rule auto-arranges windows. Invisible on the live overlay; shown only while editing.',
		binds: 'none',
		label: 'Zone',
		category: 'Utility',
		defaultSize: { w: 600, h: 400 },
		defaultConfig: { matchExe: '', matchClass: '', matchTitle: '' },
		configFields: [
			text('matchExe', 'match: exe', {
				help: 'auto-arrange: snap a window of this exe here, e.g. Spotify.exe (blank = drag-only)'
			}),
			text('matchClass', 'match: class', {
				help: 'optional window-class glob refiner, e.g. Chrome_WidgetWin_1'
			}),
			text('matchTitle', 'match: title', { help: 'optional title glob refiner, e.g. *Gmail*' })
		]
	},
	{
		// Audio output switcher (binds:'none', interactive): lists the system's render endpoints and
		// switches the default on tap. Bespoke wiring lives in AudioSwitcherHost (Tauri commands), so the
		// meter stays props-only. interactive:true so the rows catch clicks on the passive overlay.
		type: 'audioswitch',
		description:
			'Switch the default audio output device with a tap — lists your speakers/headphones/HDMI outputs and marks the active one. Windows.',
		binds: 'none',
		interactive: true,
		label: 'Audio Switcher',
		category: 'Utility',
		defaultSize: { w: 200, h: 120 },
		defaultConfig: {},
		configFields: [color('color', 'accent')]
	},
	{
		// Spacer: an invisible, space-occupying widget — pure whitespace in a flow/grid that pushes its
		// neighbours apart. binds:none, no sensor, no config; shown only as a faint outline while editing.
		type: 'spacer',
		description:
			'An invisible spacer: empty whitespace that occupies layout space to push other widgets apart. Shown only as a faint outline while editing.',
		binds: 'none',
		label: 'Spacer',
		category: 'Utility',
		defaultSize: { w: 60, h: 40 }
	},
	{
		// Countdown: counts down to a TARGET DATE ("days until X"), or runs an auto-cycling Pomodoro
		// rhythm. Self-sourcing (ticks on the wall clock); distinct from Timer (which is manual
		// start/pause). No controls — it just reflects the clock.
		type: 'countdown',
		description:
			'Counts down to a target date/time ("days until …"), or runs an auto-cycling Pomodoro work/break rhythm. Wall-clock driven (no start/pause — use Timer for that).',
		binds: 'none',
		label: 'Countdown',
		category: 'Clocks',
		intrinsic: true,
		defaultSize: { w: 170, h: 80 },
		defaultConfig: {
			mode: 'event',
			target: '',
			format: 'auto',
			countUp: false,
			workMin: 25,
			breakMin: 5,
			label: ''
		},
		configFields: [
			{
				key: 'mode',
				label: 'mode',
				kind: 'select',
				options: ['event', 'pomodoro'],
				help: 'count down to a date, or run a repeating work/break rhythm'
			},
			text('target', 'target date', {
				help: 'event mode: a date/time, e.g. 2026-12-31 or 2026-12-31T18:00'
			}),
			{
				key: 'format',
				label: 'format',
				kind: 'select',
				options: ['auto', 'dhms', 'hms', 'ms'],
				help: 'event display: auto trims units; dhms/hms/ms are fixed'
			},
			{
				key: 'countUp',
				label: 'count up after',
				kind: 'toggle',
				help: 'event mode: once the target passes, count the time elapsed since (instead of stopping at 0)'
			},
			num('workMin', 'work (min)', { min: 1, step: 1, help: 'pomodoro work length' }),
			num('breakMin', 'break (min)', { min: 1, step: 1, help: 'pomodoro break length' }),
			text('label', 'label'),
			color('color', 'color')
		]
	},
	{
		// Timer: a countdown timer or stopwatch with start/pause/reset. Self-sourcing (drives its own
		// tick) + interactive so the controls catch clicks on the passive overlay.
		type: 'timer',
		description:
			'A countdown timer or stopwatch with start / pause / reset. A countdown can loop when it reaches zero. Pick the time format; the controls work on the overlay (interactive).',
		binds: 'none',
		interactive: true,
		label: 'Timer',
		category: 'Clocks',
		defaultSize: { w: 160, h: 96 },
		defaultConfig: {
			mode: 'countdown',
			duration: 300,
			format: 'auto',
			loop: false,
			label: '',
			color: ''
		},
		configFields: [
			{
				key: 'mode',
				label: 'mode',
				kind: 'select',
				options: ['countdown', 'stopwatch'],
				help: 'count down from a duration, or up from zero'
			},
			num('duration', 'duration (s)', { min: 0, help: 'countdown length in seconds' }),
			{
				key: 'format',
				label: 'format',
				kind: 'select',
				options: ['auto', 'mm:ss', 'hh:mm:ss', 'ss'],
				help: 'time display format'
			},
			{
				key: 'loop',
				label: 'loop',
				kind: 'toggle',
				help: 'restart automatically when a countdown reaches zero'
			},
			text('label', 'label', { help: 'header text' }),
			color('color', 'color', { help: 'text colour (blank = theme)' })
		]
	}
];

// The defaultConfig keys with no matching ConfigField — i.e. config a user could only reach via the
// raw-JSON escape hatch. A regression guard for "fully UI-driven config": every meaningful key
// should be a real control. Pure + unit-tested (asserts [] for every built-in meta).
export function configCompleteness(meta: WidgetMeta): string[] {
	const have = new Set((meta.configFields ?? []).map((f) => f.key));
	return Object.keys(meta.defaultConfig ?? {}).filter((k) => !have.has(k));
}

const metas = new Map<string, WidgetMeta>();

/** Register (or replace) a widget meta. Built-ins are registered on module load. */
export function registerMeta(meta: WidgetMeta): void {
	metas.set(meta.type, meta);
}

export function getMeta(type: string): WidgetMeta | undefined {
	return metas.get(type);
}

// A formula field, resolved from a meta for the wiring layer (WidgetHost/useFormulaFields). `target`
// is the meter prop the evaluated value overrides (defaults to the field key).
export type ExprField = { key: string; result: 'number' | 'text'; target: string };

/** The `kind:'expr'` config fields of a meta, normalized (target defaulted). [] for non-formula types. */
export function exprFieldsOf(meta: WidgetMeta | undefined): ExprField[] {
	return (meta?.configFields ?? [])
		.filter((f): f is Extract<ConfigField, { kind: 'expr' }> => f.kind === 'expr')
		.map((f) => ({ key: f.key, result: f.result, target: f.target ?? f.key }));
}

/** All registered metas, in registration order (for the palette). */
export function listMetas(): WidgetMeta[] {
	return Array.from(metas.values());
}

BUILTIN_METAS.forEach(registerMeta);

/**
 * Build a default `WidgetInstance` for `type` from its registered meta (id-explicit, like
 * the old switch). Unknown types fall back to a generic 120×80 box. Pure.
 */
export function createWidget(type: string, id: string): WidgetInstance {
	const meta = metas.get(type);
	const size = meta?.defaultSize ?? { w: 120, h: 80 };
	const inst: WidgetInstance = {
		id,
		type,
		rect: { x: 24, y: 24, w: size.w, h: size.h },
		config: { ...(meta?.defaultConfig ?? {}) }
	};
	if (meta?.defaultSensor) inst.sensor = meta.defaultSensor;
	if (meta?.interactive) inst.interactive = true;
	if (meta?.defaultCss) inst.css = meta.defaultCss;
	return inst;
}
