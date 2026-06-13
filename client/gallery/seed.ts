// Synthetic, DETERMINISTIC data for the screenshot gallery: a telemetry hub seeded with
// representative sensor history, a frozen clock for the clocks, a fake audio-spectrum source, a
// seeded now-playing session (with a generated cover), and json values for the Home Assistant
// widgets. No Tauri, no randomness — so every run produces byte-identical screenshots.

import {
	createTelemetryHub,
	type SensorSample,
	type TelemetryHub
} from '../src/lib/core/telemetry';
import { handleUpdate, type SessionModel, type SessionRecord } from '../src/stores/stores';
import type { SpectrumFrame, SpectrumSource } from '../src/lib/audio/source';
// The branding icon, used as the now-playing placeholder cover (Vite resolves this to an asset URL).
import coverUrl from './cover.png';

// A fixed instant the clocks render at (Mon 2026-06-08 13:37:42 local). Picked so HH:mm:ss, the
// weekday and a two-digit date all read nicely.
export const FROZEN = new Date(2026, 5, 8, 13, 37, 42);
const T0 = FROZEN.getTime() - 120_000; // history starts 2 min before "now"

/** Replace the global Date so Clock/AnalogClock (which call `new Date()` on a timer) render at a
 * fixed time — their interval keeps re-reading the same instant, so nothing animates. */
export function freezeClock(): void {
	const fixed = FROZEN.getTime();
	const Real = Date;
	class FrozenDate extends Real {
		// Only the zero-arg form (`new Date()`, the live "now" a clock re-reads) is pinned to the frozen
		// instant. ANY explicit argument(s) construct a real date — the Calendar widget does month-grid
		// date math (`new Date(y, m, d)`) that must NOT collapse onto the frozen instant.
		constructor(...args: unknown[]) {
			if (args.length === 0) super(fixed);
			else super(...(args as ConstructorParameters<typeof Date>));
		}
		static now(): number {
			return fixed;
		}
	}
	globalThis.Date = FrozenDate as unknown as DateConstructor;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A smooth, deterministic wave generator for a sensor's history (two summed sines + a slow drift). */
function wave(base: number, amp: number, freq: number, phase: number, lo = 0, hi = 100) {
	return (i: number): number =>
		clamp(
			base + amp * Math.sin(i * freq + phase) + amp * 0.35 * Math.sin(i * freq * 2.3 + 1),
			lo,
			hi
		);
}

/** Ingest `n` per-second scalar samples for one sensor so its ring-buffer history fills (sparklines
 * and the per-core CPU grid read `.history`, not a single value). The LAST value is what gauges/bars
 * /text show. */
function series(hub: TelemetryHub, sensor: string, gen: (i: number) => number, n = 100): void {
	const batch: SensorSample[] = [];
	for (let i = 0; i < n; i++) {
		batch.push({ sensor, ts_ms: T0 + i * 1000, value: { kind: 'scalar', value: gen(i) } });
	}
	hub.ingestBatch(batch);
}

function scalar(hub: TelemetryHub, sensor: string, value: number): void {
	hub.ingest({ sensor, ts_ms: FROZEN.getTime(), value: { kind: 'scalar', value } });
}

function text(hub: TelemetryHub, sensor: string, value: string): void {
	hub.ingest({ sensor, ts_ms: FROZEN.getTime(), value: { kind: 'text', value } });
}

function json(hub: TelemetryHub, sensor: string, value: unknown): void {
	hub.ingest({ sensor, ts_ms: FROZEN.getTime(), value: { kind: 'json', value } });
}

/** Build and seed the gallery's telemetry hub with a realistic snapshot of every sensor family. */
export function makeHub(): TelemetryHub {
	const hub = createTelemetryHub();
	seedHub(hub);
	return hub;
}

/** Ingest the deterministic snapshot into an EXISTING hub — so the studio screenshot capture can feed
 * Canvas's own internal hub (via a registered demo SensorSource) and the meters render live values. */
export function seedHub(hub: TelemetryHub): void {
	// CPU: total + 12 cores (the per-core grid). Each core gets a distinct phase so the grid looks live.
	series(hub, 'cpu.total', wave(46, 22, 0.22, 0.4));
	for (let c = 0; c < 12; c++)
		series(hub, `cpu.core.${c}`, wave(40 + (c % 4) * 8, 30, 0.3, c * 1.3));
	scalar(hub, 'cpu.freq', 4480);
	scalar(hub, 'cpu.freq.current', 4790);
	scalar(hub, 'cpu.cores.logical', 24);
	text(hub, 'cpu.brand', 'AMD Ryzen 9 7900X');

	// Memory / swap (percent + a couple of byte absolutes for text demos).
	series(hub, 'mem.used', wave(58, 6, 0.15, 1.2));
	scalar(hub, 'mem.total', 34_359_738_368);
	scalar(hub, 'mem.used.bytes', 19_700_000_000);
	series(hub, 'swap.used', wave(11, 4, 0.12, 0.2));

	// Network: down/up rates (bytes/s) with bursty history for the throughput histograms.
	series(hub, 'net.down', wave(2_600_000, 2_200_000, 0.5, 0.3, 0, 8_000_000));
	series(hub, 'net.up', wave(420_000, 360_000, 0.45, 2.1, 0, 4_000_000));
	scalar(hub, 'net.total', 3_000_000);

	// GPU (the GPU panel reads the full set; any unreported metric just drops out).
	series(hub, 'gpu.util', wave(52, 26, 0.28, 0.9));
	series(hub, 'gpu.vram', wave(63, 5, 0.1, 0.5));
	scalar(hub, 'gpu.temp', 61);
	scalar(hub, 'gpu.fan', 44);
	scalar(hub, 'gpu.power', 182);
	scalar(hub, 'gpu.clock.core', 2520);
	scalar(hub, 'gpu.vram.used', 6_900_000_000);
	scalar(hub, 'gpu.vram.total', 12_884_901_888);
	text(hub, 'gpu.name', 'NVIDIA GeForce RTX 4070');

	// Disks (the widget auto-discovers volumes — two for a fuller shot) + host uptime.
	scalar(hub, 'disk.C.used.pct', 74);
	scalar(hub, 'disk.C.used', 760_000_000_000);
	scalar(hub, 'disk.C.total', 1_024_000_000_000);
	scalar(hub, 'disk.D.used.pct', 38);
	scalar(hub, 'disk.D.used', 780_000_000_000);
	scalar(hub, 'disk.D.total', 2_048_000_000_000);
	scalar(hub, 'host.uptime', 3 * 86400 + 4 * 3600 + 12 * 60);

	// Battery (laptop indicator).
	scalar(hub, 'battery.percent', 72);
	text(hub, 'battery.state', 'discharging');
	scalar(hub, 'battery.time', 8100);

	// Top process (the widget defaults to the CPU metric).
	text(hub, 'proc.cpu.top.name', 'chrome.exe');
	scalar(hub, 'proc.cpu.top.pct', 18.4);

	// Weather (Open-Meteo current conditions; the Weather widget reads weather.*).
	scalar(hub, 'weather.temp', 12);
	scalar(hub, 'weather.apparent', 10);
	scalar(hub, 'weather.humidity', 78);
	scalar(hub, 'weather.wind', 14);
	scalar(hub, 'weather.code', 3);
	scalar(hub, 'weather.is_day', 1);
	scalar(hub, 'weather.high', 15);
	scalar(hub, 'weather.low', 8);
	text(hub, 'weather.unit', 'C');
	// Multi-day forecast strip (weather.day.N.*) + sunrise/sunset for the Sun & Moon widget.
	[
		{ hi: 15, lo: 8, code: 3 },
		{ hi: 17, lo: 9, code: 1 },
		{ hi: 14, lo: 7, code: 61 },
		{ hi: 19, lo: 10, code: 0 },
		{ hi: 16, lo: 8, code: 80 }
	].forEach((d, i) => {
		scalar(hub, `weather.day.${i}.high`, d.hi);
		scalar(hub, `weather.day.${i}.low`, d.lo);
		scalar(hub, `weather.day.${i}.code`, d.code);
	});
	text(hub, 'weather.sun.rise', '2026-06-08T04:43');
	text(hub, 'weather.sun.set', '2026-06-08T21:21');

	// Network connections (the Connections widget reads net.conn.list + the totals).
	json(hub, 'net.conn.list', [
		{
			proc: 'chrome.exe',
			pid: 4123,
			established: 14,
			listening: 0,
			public: 9,
			remotes: ['142.250.72.196:443', '13.107.42.14:443', '140.82.113.25:443']
		},
		{
			proc: 'Spotify.exe',
			pid: 8821,
			established: 5,
			listening: 0,
			public: 4,
			remotes: ['35.186.224.25:443']
		},
		{
			proc: 'Discord.exe',
			pid: 6610,
			established: 6,
			listening: 0,
			public: 5,
			remotes: ['162.159.135.234:443']
		},
		{ proc: 'svchost.exe', pid: 1180, established: 2, listening: 3, public: 0, remotes: [] }
	]);
	scalar(hub, 'net.conn.established', 27);
	scalar(hub, 'net.conn.public', 18);
	scalar(hub, 'net.conn.listening', 9);

	// Ping (default host 1.1.1.1) — reachable + low latency.
	scalar(hub, 'net.ping.1.1.1.1.up', 1);
	scalar(hub, 'net.ping.1.1.1.1.ms', 12);

	// Wi-Fi link detail.
	text(hub, 'net.wifi.ssid', 'Starlink-A4F2');
	scalar(hub, 'net.wifi.signal', 82);
	scalar(hub, 'net.wifi.rssi', -59);
	scalar(hub, 'net.wifi.rx', 866);
	scalar(hub, 'net.wifi.tx', 433);
	text(hub, 'net.wifi.band', '5 GHz');
	scalar(hub, 'net.wifi.channel', 44);
	text(hub, 'net.wifi.phy', 'ax');

	// Recycle Bin.
	scalar(hub, 'recyclebin.items', 23);
	scalar(hub, 'recyclebin.bytes', 3_400_000_000);

	// Stocks (the Ticker widget reads stocks.<SYMBOL>.* — note the id uppercases the symbol).
	series(hub, 'stocks.NVDA.series', wave(878, 22, 0.18, 0.6, 820, 920), 40);
	scalar(hub, 'stocks.NVDA.price', 884.6);
	scalar(hub, 'stocks.NVDA.change', 12.43);
	text(hub, 'stocks.NVDA.currency', 'USD');
	text(hub, 'stocks.NVDA.state', 'OPEN');

	// Home Assistant demo entities (the gallery binds each HA widget to one of these ids).
	json(hub, 'demo.temperature', {
		state: '21.4',
		attributes: { friendly_name: 'Living room', unit_of_measurement: '°C' }
	});
	json(hub, 'demo.light', {
		state: 'on',
		attributes: { friendly_name: 'Desk lamp', brightness: 204, rgb_color: [255, 176, 92] }
	});
	json(hub, 'demo.climate', {
		state: 'heat',
		attributes: {
			friendly_name: 'Thermostat',
			current_temperature: 20.5,
			temperature: 22,
			hvac_action: 'heating'
		}
	});
}

/** A static, nice-looking FFT frame so the Spectrum meter renders a frozen spectrum. */
function spectrumFrame(): SpectrumFrame {
	const bands: number[] = [];
	for (let i = 0; i < 128; i++) {
		const x = i / 127;
		// A bass-heavy hump that rolls off, plus a couple of peaks — reads as music.
		const base = Math.pow(1 - x, 1.7) * 0.85;
		const peak1 = 0.5 * Math.exp(-Math.pow((x - 0.18) / 0.05, 2));
		const peak2 = 0.32 * Math.exp(-Math.pow((x - 0.46) / 0.06, 2));
		bands.push(clamp(base + peak1 + peak2 + 0.06, 0, 1));
	}
	return { bands, rms: 0.4, ts_ms: FROZEN.getTime() };
}

/** A SpectrumSource serving one fixed frame — drives both the onFrame draw path and latestFrame. */
export const fakeSpectrum: SpectrumSource = {
	acquire: () => () => undefined,
	onFrame: (cb) => {
		cb(spectrumFrame());
		return () => undefined;
	},
	latestFrame: () => spectrumFrame()
};

/** Composite the branding icon onto a deterministic gradient and return PNG bytes — the now-playing
 * placeholder cover. Falls back to the gradient alone if the icon can't be drawn. */
async function coverBytes(): Promise<number[]> {
	const c = document.createElement('canvas');
	c.width = 240;
	c.height = 240;
	const ctx = c.getContext('2d');
	if (!ctx) return [];
	const g = ctx.createLinearGradient(0, 0, 240, 240);
	g.addColorStop(0, '#1c3a44');
	g.addColorStop(0.55, '#122a31');
	g.addColorStop(1, '#0b1d22');
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 240, 240);
	try {
		const img = await loadImage(coverUrl);
		const s = 184; // draw the icon centred at ~77% so it reads as cover art
		ctx.drawImage(img, (240 - s) / 2, (240 - s) / 2, s, s);
	} catch {
		// gradient-only fallback
	}
	const bytes = atob(c.toDataURL('image/png').split(',')[1]);
	return Array.from(bytes, (ch) => ch.charCodeAt(0));
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = reject;
		img.src = src;
	});
}

/** Seed the module-level media store with one playing session (so NowPlaying renders a real track). */
export async function seedMedia(): Promise<void> {
	const data = await coverBytes();
	const model: SessionModel = {
		source: 'foobar2000',
		playback: { auto_repeat: 'None', rate: 1, shuffle: false, status: 'Playing', type: 'Music' },
		timeline: { end: 254_000, last_updated_at_ms: FROZEN.getTime(), position: 96_000, start: 0 },
		media: {
			album: { artist: 'The Violet Hour', title: 'Neon Cartography', track_count: 11 },
			artist: 'The Violet Hour',
			genres: ['Electronic'],
			playback_type: 'Music' as const,
			subtitle: '',
			title: 'Midnight Drive',
			track_number: 4
		}
	};
	const record: SessionRecord = {
		session_id: 1,
		source: 'foobar2000',
		timestamp_created: null,
		timestamp_updated: null,
		last_media_update: { Media: [model, { content_type: 'image/png', data }] },
		last_model_update: { Model: model }
	};
	handleUpdate({ sessionRecord: record });
}
