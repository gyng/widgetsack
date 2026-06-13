// Studio Diagnostics panel (settings → Diagnostics): polls every window over the diag bridge and shows
// each one's JS heap, retained now-playing sessions + album-art bytes, sensor counts, and DOM size —
// so a memory leak shows up as a climbing heap (and a climbing "art" total is the media-store
// fingerprint). The window LIST comes from the backend (list_window_labels), not the JS reports, so a
// window whose webview crashed — and therefore stopped reporting — still appears (marked "not
// responding") instead of vanishing. Its recovery controls (open devtools, drop click-through) go
// through the backend too, so they work even when that window's own JS is dead. All cross-window
// plumbing lives in lib/diag.ts; the folds/shapes in core/diagnostics.ts.
import { useEffect, useState } from 'react';
import {
	heapUsedFraction,
	mergeReport,
	mergeWindowList,
	type WindowDiag
} from '../core/diagnostics';
import { formatBytes } from '../core/format';
import { formatDuration } from '../core/timer';
import {
	getProcessDiagnostics,
	getSubsystemTimings,
	listenDiagReports,
	listWindowLabels,
	openDevtoolsFor,
	reloadWindow,
	requestDiagnostics,
	setSubsystemProfiling,
	setWindowInteractive,
	type ProcessDiag,
	type SubsystemTiming
} from '../diag';
import { widgetCosts, resetWidgetProfile, type WidgetCost } from './canvas/widgetProfile';
import './DiagnosticsPanel.css';

const POLL_MS = 1500;
// A window that hasn't reported within this window is treated as not responding (closed / crashed). It
// stays listed (the backend still knows the OS window) so it can be rescued / inspected by label.
const STALE_MS = 6000;

export default function DiagnosticsPanel() {
	const [reports, setReports] = useState<Record<string, WindowDiag>>({});
	// Authoritative window labels from the backend — the source of truth for which windows exist.
	const [labels, setLabels] = useState<string[]>([]);
	// The native (Rust host) process's CPU% + memory — polled by command, not the per-window bridge.
	const [proc, setProc] = useState<ProcessDiag | null>(null);
	// Local mirror of the click-through toggle we last sent each overlay (the overlay owns the truth;
	// this just reflects the control state).
	const [interactive, setInteractive] = useState<Record<string, boolean>>({});
	// This (studio) window's per-widget render cost, from the <Profiler>s Canvas wraps each widget in.
	const [costs, setCosts] = useState<WidgetCost[]>([]);
	// Per-subsystem backend CPU timing (Rust). Demand-gated: enabled only while this panel is open.
	const [timings, setTimings] = useState<SubsystemTiming[]>([]);

	useEffect(() => {
		let alive = true;
		const offReports = listenDiagReports((r) => {
			if (!alive) return;
			// Re-stamp arrival on the STUDIO clock — each window's performance.now() is its own domain, so
			// the reporter's `at` isn't comparable across windows; the studio clock makes staleness valid.
			setReports((prev) => mergeReport(prev, { ...r, at: performance.now() }));
		});
		// Poll the native process alongside the per-window heap poll (CPU% needs the repeated call to
		// build a delta, so the first tick reads ~0 and settles after one interval).
		const pollProc = () =>
			void getProcessDiagnostics().then((p) => {
				if (alive && p) setProc(p);
			});
		const pollLabels = () =>
			void listWindowLabels().then((l) => {
				if (alive && l.length) setLabels(l);
			});
		// Turn ON the backend per-subsystem timing while this panel is mounted (demand-gated — it's
		// inert otherwise), and poll it alongside the rest.
		void setSubsystemProfiling(true);
		const pollTimings = () =>
			void getSubsystemTimings().then((t) => {
				if (alive) setTimings(t);
			});
		requestDiagnostics();
		pollProc();
		pollLabels();
		setCosts(widgetCosts());
		pollTimings();
		const poll = window.setInterval(() => {
			requestDiagnostics();
			pollProc();
			pollLabels();
			setCosts(widgetCosts());
			pollTimings();
		}, POLL_MS);
		return () => {
			alive = false;
			void offReports.then((un) => un());
			clearInterval(poll);
			void setSubsystemProfiling(false);
		};
	}, []);

	const rows = mergeWindowList(reports, labels, performance.now(), STALE_MS);

	const toggleInteractive = (label: string, value: boolean): void => {
		setInteractive((m) => ({ ...m, [label]: value }));
		void setWindowInteractive(label, value);
	};

	return (
		<div className="diag">
			{proc && (
				<div className="diag-win diag-proc">
					<div className="diag-win-hd">
						<span className="diag-label">native process</span>
						<span className="dim">
							Rust host · pid {proc.pid} · {proc.cpus} cpus
						</span>
					</div>
					<div className="diag-stats">
						<span title="Host-process CPU as a % of the whole machine (WebView2 renderers are separate processes — their JS heap is the rows below)">
							cpu {proc.cpuPercent.toFixed(1)}%
						</span>
						<span title="Resident set size (physical memory) of the Rust host process">
							rss {formatBytes(proc.memBytes)}
						</span>
						<span title="Virtual memory size of the host process">
							virt {formatBytes(proc.virtualBytes)}
						</span>
						<span title="How long the host process has been running">
							up {formatDuration(proc.uptimeSecs)}
						</span>
					</div>
				</div>
			)}
			{timings.length > 0 && (
				<div className="diag-win diag-cost">
					<div className="diag-win-hd">
						<span className="diag-label">backend CPU by subsystem</span>
						<span className="dim">Rust host · ms/s · avg</span>
					</div>
					<div className="diag-cost-list">
						{timings.slice(0, 10).map((t) => (
							<div className="diag-cost-row" key={t.key} data-hot={t.msPerSec >= 5 || undefined}>
								<span className="diag-cost-name" title={`${t.samples} runs`}>
									{t.key}
								</span>
								<span title="CPU load: ms of work per second (avg × runs/sec) — the real cost">
									{t.msPerSec.toFixed(1)} ms/s
								</span>
								<span title="average time per run">{t.avgMs.toFixed(2)}ms</span>
								<span className="dim" title="how often it runs">
									{t.perSec.toFixed(1)}/s
								</span>
							</div>
						))}
					</div>
				</div>
			)}
			<div className="diag-win diag-cost">
				<div className="diag-win-hd">
					<span className="diag-label">widget render cost</span>
					<span className="dim">this studio · re-renders/s · render ms</span>
					{costs.length > 0 && (
						<button
							type="button"
							className="diag-cost-reset"
							title="Clear the captured render stats and start fresh"
							onClick={() => {
								resetWidgetProfile();
								setCosts([]);
							}}
						>
							reset
						</button>
					)}
				</div>
				{costs.length === 0 ? (
					<div className="rp-stub">
						No renders captured yet — open a layout in the studio (each widget is profiled here).
					</div>
				) : (
					<div className="diag-cost-list">
						{costs.slice(0, 8).map((c) => (
							<div className="diag-cost-row" key={c.id} data-hot={c.perSec >= 2 || undefined}>
								<span className="diag-cost-name" title={c.id}>
									{c.type}
								</span>
								<span title="re-renders per second — a high steady number is churn (re-rendering when nothing changed)">
									{c.perSec.toFixed(1)}/s
								</span>
								<span title="average render (React reconcile) time — not paint/GPU">
									{c.avgMs.toFixed(2)}ms
								</span>
								<span className="dim" title="commits captured">
									×{c.commits}
								</span>
							</div>
						))}
					</div>
				)}
			</div>
			<div className="rp-stub diag-note">
				“Widget render cost” measures how often + how long each widget RE-RENDERS in this studio
				window (React Profiler). A high steady re-renders/s is churn; the ms is React reconcile
				time, not paint or GPU — use Devtools below for those. The heap / DOM rows are per overlay
				window.
			</div>
			{rows.length === 0 ? (
				<div className="rp-stub">Polling windows…</div>
			) : (
				rows.map((row) => {
					const r = row.report;
					const frac = r ? heapUsedFraction(r.heap) : null;
					return (
						<div className={`diag-win${row.responding ? '' : ' diag-stale'}`} key={row.label}>
							<div className="diag-win-hd">
								<span className="diag-label">{row.label}</span>
								<span className="dim">
									{row.role}
									{r?.monitor != null ? ` · mon ${r.monitor}` : ''}
									{!row.responding && (
										<>
											{' · '}
											<span
												className="diag-warn"
												title="No reply to the last polls — the window is closed, launching, or its webview crashed. Use the controls below to inspect or reach it."
											>
												not responding
											</span>
										</>
									)}
								</span>
							</div>
							{r && (
								<div className="diag-stats">
									<span title="JS heap used / limit (Chromium estimate)">
										heap{' '}
										{r.heap
											? `${formatBytes(r.heap.usedBytes)} / ${formatBytes(r.heap.limitBytes)}`
											: 'n/a'}
										{frac != null ? ` · ${Math.round(frac * 100)}%` : ''}
									</span>
									<span title="now-playing sessions retained, and total album-art bytes held">
										sessions {r.sessions} · art {formatBytes(r.artBytes)}
									</span>
									<span title="sensors active / total seen by this window's hub">
										sensors {r.activeSensors}/{r.sensors}
									</span>
									<span title="DOM element count">dom {r.domNodes}</span>
								</div>
							)}
							{r && r.widgets.length > 0 && (
								<div
									className="diag-widgets"
									title="DOM nodes owned per widget type (heaviest first) — a climbing total is a per-widget DOM leak"
								>
									{r.widgets.slice(0, 6).map((w) => (
										<span key={w.type} className="diag-widget">
											{w.type}
											{w.count > 1 ? `×${w.count}` : ''} <b>{w.nodes}</b>
										</span>
									))}
								</div>
							)}
							{row.role !== 'studio' && (
								<div className="diag-actions">
									<button type="button" onClick={() => void openDevtoolsFor(row.label)}>
										⌗ Devtools
									</button>
									<button
										type="button"
										onClick={() => void reloadWindow(row.label)}
										title="Reload this window's webview — respawns its renderer to recover a crashed (Out of Memory) overlay without relaunching the app."
									>
										↻ Reload
									</button>
									<label
										className="diag-toggle"
										title="Disable click-through so you can interact with / right-click this overlay (then open devtools). Driven from the backend, so it works even on a crashed window. Toggle off when done."
									>
										<input
											type="checkbox"
											checked={!!interactive[row.label]}
											onChange={(e) => toggleInteractive(row.label, e.currentTarget.checked)}
										/>
										interactive
									</label>
								</div>
							)}
						</div>
					);
				})
			)}
			<div className="rp-stub diag-note">
				Watch an overlay’s heap climb to confirm a leak; a steadily-rising “art” total is the
				media-store fingerprint. A “not responding” window has likely crashed — “interactive” (or
				the Ctrl+Alt+Shift+E rescue hotkey) drops its click-through so you can reach its Reload
				page; “Devtools” inspects it. Both work from the backend, so a dead webview is still
				reachable.
			</div>
		</div>
	);
}
