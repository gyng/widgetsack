// Outer-ring adapter (AGENTS.md §5): the cross-window diagnostics bridge behind the studio's
// Diagnostics panel. EVERY window runs a responder that answers the studio's poll with its own
// heap/counts (collectLocalDiagnostics) and obeys debug commands targeted at it (open devtools / toggle
// click-through). The studio polls, collects the reports, and drives the commands. Pure shapes + folds
// live in core/diagnostics.ts; Tauri lives only here.

import { emit, emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
	aggregateWidgets,
	formatDiagTrail,
	heapFromMemory,
	roleFromLabel,
	type DiagMemory,
	type WidgetBreakdown,
	type WindowDiag
} from './core/diagnostics';
import type { TelemetryHub } from './core/telemetry';
import { mediaStore } from '../stores/stores';
import { sumArtBytes } from './components/NowPlaying/priority';
import { monitorParam } from './overlay';
import { COMMANDS, EVENTS } from './bridge/contract';

const DIAG_REQUEST = EVENTS.diagRequest; // studio → all windows: report your stats
const DIAG_REPORT = EVENTS.diagReport; // window → studio: a WindowDiag

/** The native (Rust HOST) process's perf snapshot. Mirrors `ProcessDiag` in
 * `widgetsack/src/process_diag.rs`. On Windows the WebView2 renderers are SEPARATE processes (their JS
 * heap is the per-window rows), so this is the Tauri host process alone. */
export type ProcessDiag = {
	pid: number;
	/** CPU usage as a percent of the whole machine (like `cpu.total`). */
	cpuPercent: number;
	/** Resident set size (physical memory) in bytes. */
	memBytes: number;
	/** Virtual memory size in bytes. */
	virtualBytes: number;
	/** Seconds the process has been running. */
	uptimeSecs: number;
	/** Logical CPU count. */
	cpus: number;
};

/** Poll the native process's CPU% + memory (studio only). Resolves `null` outside Tauri (tests) or if
 * the command fails, so the panel just omits the row rather than erroring. */
export async function getProcessDiagnostics(): Promise<ProcessDiag | null> {
	try {
		return await invoke<ProcessDiag>(COMMANDS.processDiagnostics);
	} catch {
		return null;
	}
}

/** One backend subsystem's CPU timing. Mirrors `SubsystemTiming` in `widgetsack/src/timings.rs`.
 * `msPerSec` (avg × runs/sec) is the headline load: ms of CPU the subsystem uses per second. */
export type SubsystemTiming = {
	key: string;
	avgMs: number;
	lastMs: number;
	samples: number;
	perSec: number;
	msPerSec: number;
};

/** Turn the demand-gated backend timing instrumentation on/off (the Diagnostics panel enables it while
 * open, so there's no cost when nobody's watching). Best-effort. */
export async function setSubsystemProfiling(enabled: boolean): Promise<void> {
	try {
		await invoke(COMMANDS.setSubsystemProfiling, { enabled });
	} catch {
		// not in Tauri / not the studio — the panel just shows nothing
	}
}

/** Poll the per-subsystem CPU timings (busiest first). Empty outside Tauri / before profiling runs. */
export async function getSubsystemTimings(): Promise<SubsystemTiming[]> {
	try {
		return (await invoke<SubsystemTiming[]>(COMMANDS.subsystemTimings)) ?? [];
	} catch {
		return [];
	}
}

/** Read this window's heap (Chromium / WebView2 only `performance.memory`) past the type checker. */
function readMemory(): DiagMemory | undefined {
	const perf = performance as Performance & { memory?: DiagMemory };
	return perf.memory;
}

/** Per-widget-type DOM weight for THIS window: attribute every element under a widget to its NEAREST
 * `[data-w]` ancestor (so a group and its children partition the DOM rather than double-counting), then
 * fold by `data-type`. A type whose node total climbs over time is a DOM leak — the live, per-widget
 * proxy for "which widget is eating memory" (true per-component heap bytes aren't exposed by any API). */
function collectWidgetBreakdown(): WidgetBreakdown[] {
	if (typeof document === 'undefined') return [];
	const own = new Map<Element, { type: string; nodes: number }>();
	const widgetEls = document.querySelectorAll<HTMLElement>('[data-w]');
	widgetEls.forEach((el) => own.set(el, { type: el.dataset.type || '?', nodes: 0 }));
	// Count widget roots + every descendant once, charging each to its nearest widget ancestor.
	document.querySelectorAll('[data-w], [data-w] *').forEach((el) => {
		const owner = el.closest('[data-w]');
		const entry = owner ? own.get(owner) : undefined;
		if (entry) entry.nodes += 1;
	});
	return aggregateWidgets([...own.values()]);
}

/** Gather THIS window's diagnostics snapshot. `hub` may be null before the telemetry hub mounts. */
export function collectLocalDiagnostics(hub: TelemetryHub | null): WindowDiag {
	let label = 'unknown';
	try {
		label = getCurrentWindow().label;
	} catch {
		/* outside Tauri (tests) — keep the placeholder */
	}
	const sessions = mediaStore.getSnapshot().sessions;
	return {
		label,
		role: roleFromLabel(label),
		monitor: monitorParam(),
		heap: heapFromMemory(readMemory()),
		sessions: Object.keys(sessions).length,
		artBytes: sumArtBytes(sessions),
		sensors: hub ? hub.sensorIds().length : 0,
		activeSensors: hub ? hub.activeSensorIds().length : 0,
		domNodes: typeof document !== 'undefined' ? document.getElementsByTagName('*').length : 0,
		widgets: collectWidgetBreakdown(),
		at: typeof performance !== 'undefined' ? performance.now() : 0
	};
}

/** Run the per-window responder: answer the studio's heap/stats poll. Mount ONCE per window (both
 * roles). `getHub` is read lazily so the freshest hub is used. Resolves to a teardown that removes the
 * listener. (Debug ACTIONS — devtools / drop click-through — are NOT handled here: they go through the
 * backend by-label commands so they keep working when this window's webview has crashed.) */
export async function startDiagResponder(getHub: () => TelemetryHub | null): Promise<UnlistenFn> {
	const offRequest = await listen(DIAG_REQUEST, () => {
		void emitTo('studio', DIAG_REPORT, collectLocalDiagnostics(getHub())).catch(() => undefined);
	});
	return offRequest;
}

/** Studio side: poll every window for a fresh report (broadcast — the studio answers itself too). */
export function requestDiagnostics(): void {
	void emit(DIAG_REQUEST).catch(() => undefined);
}

/** Studio side: subscribe to incoming reports. Resolves to the unlisten fn. */
export function listenDiagReports(cb: (report: WindowDiag) => void): Promise<UnlistenFn> {
	return listen<WindowDiag>(DIAG_REPORT, (ev) => cb(ev.payload));
}

// --- backend-driven recovery (works on a CRASHED window) -------------------------------------------
// The JS bridge above dies with a window's webview, so these go through the Rust backend (the OS window
// object outlives the renderer). Used by the Diagnostics panel so a crashed overlay stays listable,
// inspectable, and rescuable even when its own JS is gone.

/** Every live app window's label, straight from the backend (the source of truth for the panel's rows,
 *  so a crashed/quiet window still appears). Resolves to [] outside Tauri / on failure. */
export async function listWindowLabels(): Promise<string[]> {
	try {
		return await invoke<string[]>(COMMANDS.listWindowLabels);
	} catch {
		return [];
	}
}

/** Open devtools for the window `label` from the backend — reaches a crashed/passive overlay the JS
 *  bridge can't. */
export async function openDevtoolsFor(label: string): Promise<void> {
	try {
		await invoke(COMMANDS.openDevtoolsFor, { label });
	} catch (err) {
		console.warn('open_devtools_for failed', label, err);
	}
}

/** Drop/restore whole-window click-through for `label` from the backend (and, when made interactive,
 *  bring it forward) — so a crashed overlay's click-through can be cleared to reach its "Reload" page. */
export async function setWindowInteractive(label: string, interactive: boolean): Promise<void> {
	try {
		await invoke(COMMANDS.setWindowInteractive, { label, interactive });
	} catch (err) {
		console.warn('set_window_interactive failed', label, err);
	}
}

/** Reload the webview of `label` from the backend — respawns a crashed overlay's renderer (recovers the
 *  "Out of Memory" page) without relaunching the app. */
export async function reloadWindow(label: string): Promise<void> {
	try {
		await invoke(COMMANDS.reloadWindow, { label });
	} catch (err) {
		console.warn('reload_window failed', label, err);
	}
}

// --- memory trail: each window logs its diagnostics to the rotating log file on an interval ----------
// The Diagnostics panel only shows live windows; an UNATTENDED overnight leak crashes the overlay
// before anyone sees the climb. Persisting a compact summary to disk every interval means the run-up to
// the OOM survives the crash — read the last `memtrail` lines (widgetsack.log) to see which metric (JS
// heap / DOM / retained art / a specific widget) was growing.

/** Append THIS window's diagnostics summary to the backend's rotating log file (best-effort). */
export async function logDiag(getHub: () => TelemetryHub | null): Promise<void> {
	try {
		await invoke(COMMANDS.logDiag, { summary: formatDiagTrail(collectLocalDiagnostics(getHub())) });
	} catch {
		/* outside Tauri / command unavailable — the trail just doesn't record */
	}
}

/** Start the memory trail for this window: log a diagnostics summary now and every `intervalMs`.
 *  Mount ONCE per window. Returns a stop fn that clears the interval. */
export function startMemoryTrail(
	getHub: () => TelemetryHub | null,
	intervalMs = 30_000
): () => void {
	void logDiag(getHub); // a baseline line at startup
	const id = setInterval(() => void logDiag(getHub), intervalMs);
	return () => clearInterval(id);
}
