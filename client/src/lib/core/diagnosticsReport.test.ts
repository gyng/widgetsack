import { describe, expect, it } from 'vitest';
import type { LogRecord } from './logs';
import {
	LOG_CHIPS,
	composeDiagnosticsReport,
	filterLogs,
	formatLogLine,
	isTraceLine,
	matchesChip,
	selectReportLogs
} from './diagnosticsReport';

const rec = (over: Partial<LogRecord> = {}): LogRecord => ({
	ts_ms: 1_700_000_000_000,
	level: 'info',
	target: 'sensors',
	message: 'tick',
	...over
});

const overlayRefit = (message: string, over: Partial<LogRecord> = {}): LogRecord =>
	rec({ target: 'client', fields: { component: 'overlay', window: 'main' }, message, ...over });

describe('matchesChip / LOG_CHIPS', () => {
	it('matches on target, narrowing to the component when the chip names one', () => {
		const [watchdog, displaywatch, client] = LOG_CHIPS;
		expect(matchesChip(rec({ target: 'watchdog' }), watchdog)).toBe(true);
		expect(matchesChip(rec({ target: 'sensors' }), watchdog)).toBe(false);
		expect(matchesChip(rec({ target: 'displaywatch' }), displaywatch)).toBe(true);
		// The client chip wants target `client` AND component `overlay`.
		expect(matchesChip(overlayRefit('refit start'), client)).toBe(true);
		expect(matchesChip(rec({ target: 'client', fields: { component: 'layout' } }), client)).toBe(
			false
		);
		expect(matchesChip(rec({ target: 'client' }), client)).toBe(false); // no fields at all
	});
});

describe('filterLogs', () => {
	const logs = [
		rec({ level: 'debug', target: 'sensors', message: 'd' }),
		rec({ level: 'info', target: 'watchdog', message: 'i' }),
		rec({ level: 'warn', target: 'ha', message: 'w' }),
		rec({ level: 'error', target: 'client', fields: { component: 'overlay' }, message: 'e' })
	];

	it('keeps records at or above the minimum level (warn+ by default in the pane)', () => {
		expect(filterLogs(logs, { minLevel: 'warn', target: '' }).map((r) => r.message)).toEqual([
			'w',
			'e'
		]);
		expect(filterLogs(logs, { minLevel: 'trace', target: '' })).toHaveLength(4);
	});

	it('matches the target text against the target or the client component, case-insensitively', () => {
		expect(filterLogs(logs, { minLevel: 'trace', target: 'WATCH' }).map((r) => r.target)).toEqual([
			'watchdog'
		]);
		expect(
			filterLogs(logs, { minLevel: 'trace', target: 'overlay' }).map((r) => r.message)
		).toEqual(['e']);
		// Whitespace-only is treated as no filter.
		expect(filterLogs(logs, { minLevel: 'trace', target: '  ' })).toHaveLength(4);
	});
});

describe('isTraceLine / selectReportLogs', () => {
	it('flags watchdog, displaywatch, and overlay refit client lines only', () => {
		expect(isTraceLine(rec({ target: 'watchdog', level: 'debug' }))).toBe(true);
		expect(isTraceLine(rec({ target: 'displaywatch' }))).toBe(true);
		expect(isTraceLine(overlayRefit('refit done (main) in 12ms'))).toBe(true);
		// Overlay client lines that aren't about a refit, and other components, are not trace lines.
		expect(isTraceLine(overlayRefit('layer applied'))).toBe(false);
		expect(
			isTraceLine(rec({ target: 'client', fields: { component: 'layout' }, message: 'refit' }))
		).toBe(false);
		expect(isTraceLine(rec({ target: 'sensors' }))).toBe(false);
	});

	it('keeps every trace line plus the LAST N warn/error, once each, in chronological order', () => {
		const logs: LogRecord[] = [];
		logs.push(rec({ target: 'watchdog', message: 'w0' }));
		for (let i = 0; i < 60; i++) logs.push(rec({ level: 'warn', message: `warn${i}` }));
		logs.push(rec({ target: 'displaywatch', level: 'error', message: 'both' })); // trace AND warn+
		logs.push(rec({ target: 'sensors', message: 'noise' }));
		const out = selectReportLogs(logs, 50);
		// 1 trace + last 50 of 61 warn/error (of which 'both' is also a trace line → counted once).
		expect(out).toHaveLength(1 + 50);
		expect(out[0].message).toBe('w0');
		expect(out[1].message).toBe('warn11'); // the oldest 11 warnings fell off
		expect(out.at(-1)?.message).toBe('both');
		expect(out.some((r) => r.message === 'noise')).toBe(false);
	});
});

describe('formatLogLine', () => {
	it('renders time, padded level, target, message and k=v fields', () => {
		expect(formatLogLine(rec({ level: 'warn', fields: { a: '1', b: 'two' } }))).toBe(
			'2023-11-14T22:13:20.000Z WARN  sensors: tick a=1 b=two'
		);
		expect(formatLogLine(rec({ level: 'error' }))).toBe(
			'2023-11-14T22:13:20.000Z ERROR sensors: tick'
		);
	});
});

describe('composeDiagnosticsReport', () => {
	it('lists version, log path, monitors with stable keys, the process row and the selected log', () => {
		const text = composeDiagnosticsReport({
			appVersion: '0.0.55',
			now: 1_700_000_000_000,
			monitors: [
				{ key: 'default', label: 'DISPLAY1 · DELL (primary)', name: 'DISPLAY1', w: 2560, h: 1440 },
				{ key: 'dell-u2720q-abc', label: 'DISPLAY2 · DELL', name: 'DISPLAY2', w: 1920, h: 1080 }
			],
			process: {
				pid: 42,
				cpuPercent: 3.25,
				memBytes: 256 * 1048576,
				virtualBytes: 512 * 1048576,
				uptimeSecs: 90,
				cpus: 8
			},
			logs: [rec({ target: 'watchdog', message: 'stall 1200ms' }), rec({ message: 'noise' })],
			logFilePath: 'C:/logs/widgetsack.log'
		});
		expect(text).toContain('widgetsack diagnostics · v0.0.55 · 2023-11-14T22:13:20.000Z');
		expect(text).toContain('log file: C:/logs/widgetsack.log');
		expect(text).toContain('- default: DISPLAY1 · DELL (primary) [DISPLAY1 2560×1440]');
		expect(text).toContain('- dell-u2720q-abc: DISPLAY2 · DELL [DISPLAY2 1920×1080]');
		expect(text).toContain('pid 42 · cpu 3.3% · rss 256.0 MiB · virt 512.0 MiB · up 90s · 8 cpus');
		expect(text).toContain('· 1 of 2)');
		expect(text).toContain('watchdog: stall 1200ms');
		expect(text).not.toContain('noise');
	});

	it('degrades gracefully with nothing known', () => {
		const text = composeDiagnosticsReport({
			appVersion: null,
			now: 0,
			monitors: [],
			process: null,
			logs: [],
			logFilePath: null
		});
		expect(text).toContain('vunknown');
		expect(text).toContain('log file: unknown');
		expect(text).toContain('(none reported)');
		expect(text).toContain('(no snapshot)');
		expect(text).toContain('(nothing captured)');
	});
});
