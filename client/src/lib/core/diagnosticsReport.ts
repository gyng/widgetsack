// Pure domain behind the Diagnostics tab's Logs pane + "Copy diagnostics" button (AGENTS.md §5: no
// React/Tauri/DOM). The panel gathers the inputs (version, monitors, process snapshot, log
// backlog, log path) and hands them here; this composes the text report and owns the log
// filtering rules, so both are unit-tested without a window.
import { atLeastLevel, type LogLevel, type LogRecord } from './logs';

/** A monitor line for the report: the stable layout key + what the studio switcher shows. */
export type ReportMonitor = { key: string; label: string; name: string; w: number; h: number };

/** The host-process snapshot the panel already polls (structural mirror of lib/diag's ProcessDiag). */
export type ReportProcess = {
	pid: number;
	cpuPercent: number;
	memBytes: number;
	virtualBytes: number;
	uptimeSecs: number;
	cpus: number;
};

export type DiagnosticsReportInput = {
	appVersion: string | null;
	/** Wall-clock ms the report was composed at (injected: keeps Date.now() out of the domain). */
	now: number;
	monitors: ReportMonitor[];
	process: ReportProcess | null;
	logs: LogRecord[];
	logFilePath: string | null;
};

/** How many trailing warn/error lines the report keeps (the boot/overlay lines are unbounded). */
export const REPORT_WARN_LINES = 50;

// --- log filtering (shared by the Logs pane and the report) ---

/** A quick-filter chip: a backend `target`, optionally narrowed to one client `component`. */
export type LogChip = { id: string; label: string; target: string; component?: string };

/** The Logs pane's quick chips: the two hang-diagnosis subsystems and the overlay's own client
 * log (`log_client` records land under target `client` with `fields.component` naming the caller). */
export const LOG_CHIPS: LogChip[] = [
	{ id: 'watchdog', label: 'watchdog', target: 'watchdog' },
	{ id: 'displaywatch', label: 'displaywatch', target: 'displaywatch' },
	{ id: 'client', label: 'client · overlay', target: 'client', component: 'overlay' }
];

/** Whether a record belongs to a chip's target (+ component, when the chip names one). */
export function matchesChip(record: LogRecord, chip: LogChip): boolean {
	if (record.target !== chip.target) return false;
	return chip.component === undefined || record.fields?.component === chip.component;
}

export type LogFilter = {
	minLevel: LogLevel;
	/** Free-text match on the target or the client component (case-insensitive substring). */
	target: string;
};

/** Apply the pane's level + target filter. Empty `target` matches everything. */
export function filterLogs(logs: LogRecord[], filter: LogFilter): LogRecord[] {
	const needle = filter.target.trim().toLowerCase();
	return logs.filter((r) => {
		if (!atLeastLevel(r.level, filter.minLevel)) return false;
		if (!needle) return true;
		const component = r.fields?.component?.toLowerCase() ?? '';
		return r.target.toLowerCase().includes(needle) || component.includes(needle);
	});
}

// --- the report ---

/** The lines every report carries regardless of level: the stall watchdog, the display-change
 * watcher, and the overlays' refit trail — the trio that reconstructs a monitor-switch hang. */
export function isTraceLine(r: LogRecord): boolean {
	if (r.target === 'watchdog' || r.target === 'displaywatch') return true;
	return r.target === 'client' && r.fields?.component === 'overlay' && /refit/i.test(r.message);
}

/** Pick the report's log lines: every trace line (see `isTraceLine`) plus the last `warnLimit`
 * warn/error records, de-duplicated and in original (chronological) order. */
export function selectReportLogs(logs: LogRecord[], warnLimit = REPORT_WARN_LINES): LogRecord[] {
	const keep = new Set<LogRecord>();
	for (const r of logs) if (isTraceLine(r)) keep.add(r);
	const warnings = logs.filter((r) => atLeastLevel(r.level, 'warn'));
	for (const r of warnings.slice(-warnLimit)) keep.add(r);
	return logs.filter((r) => keep.has(r));
}

/** One log record as a report line: ISO time, level, target, message, then `k=v` fields. */
export function formatLogLine(r: LogRecord): string {
	const fields = Object.entries(r.fields ?? {})
		.map(([k, v]) => ` ${k}=${v}`)
		.join('');
	return `${new Date(r.ts_ms).toISOString()} ${r.level.toUpperCase().padEnd(5)} ${r.target}: ${r.message}${fields}`;
}

const mib = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MiB`;

/** Compose the plain-text diagnostics report the panel copies to the clipboard. */
export function composeDiagnosticsReport(input: DiagnosticsReportInput): string {
	const lines: string[] = [
		`widgetsack diagnostics · v${input.appVersion ?? 'unknown'} · ${new Date(input.now).toISOString()}`,
		`log file: ${input.logFilePath ?? 'unknown'}`,
		'',
		'## monitors'
	];
	if (input.monitors.length === 0) lines.push('(none reported)');
	for (const m of input.monitors) {
		lines.push(`- ${m.key}: ${m.label} [${m.name} ${m.w}×${m.h}]`);
	}
	lines.push('', '## host process');
	const p = input.process;
	if (p) {
		lines.push(
			`pid ${p.pid} · cpu ${p.cpuPercent.toFixed(1)}% · rss ${mib(p.memBytes)} · virt ${mib(p.virtualBytes)} · up ${p.uptimeSecs}s · ${p.cpus} cpus`
		);
	} else {
		lines.push('(no snapshot)');
	}
	const selected = selectReportLogs(input.logs);
	lines.push(
		'',
		`## log (watchdog/displaywatch/overlay refit + last ${REPORT_WARN_LINES} warn/error · ${selected.length} of ${input.logs.length})`
	);
	if (selected.length === 0) lines.push('(nothing captured)');
	for (const r of selected) lines.push(formatLogLine(r));
	return lines.join('\n');
}
