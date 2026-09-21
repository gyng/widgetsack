import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import type { WindowDiag } from '../core/diagnostics';

// Mock the cross-window diagnostics bridge (the Tauri adapter): the panel polls these on an
// interval and subscribes to live reports. Each fn is a spy so we can drive what the panel sees
// and assert which backend command a recovery button fires. `listenDiagReports` captures the
// callback so a test can push a synthetic WindowDiag through it.
let reportCb: ((r: WindowDiag) => void) | null = null;
const unlisten = vi.fn();
vi.mock('../diag', () => ({
	getProcessDiagnostics: vi.fn(() => Promise.resolve(null)),
	getSubsystemTimings: vi.fn(() => Promise.resolve([])),
	listWindowLabels: vi.fn(() => Promise.resolve([])),
	listenDiagReports: vi.fn((cb: (r: WindowDiag) => void) => {
		reportCb = cb;
		return Promise.resolve(unlisten);
	}),
	openDevtoolsFor: vi.fn(() => Promise.resolve()),
	reloadWindow: vi.fn(() => Promise.resolve()),
	requestDiagnostics: vi.fn(),
	setSubsystemProfiling: vi.fn(() => Promise.resolve()),
	setWindowInteractive: vi.fn(() => Promise.resolve())
}));

// Mock the per-widget render-cost accumulator (module singleton) so the panel renders a known set
// of cost rows and we can assert the reset button clears them.
vi.mock('./canvas/widgetProfile', () => ({
	widgetCosts: vi.fn(() => []),
	resetWidgetProfile: vi.fn()
}));

// The structured-log adapter (lib/logs.ts): backlog + live stream + log path + reveal. `subscribeLogs`
// captures its callback so a test can push a live record through.
let logCb: ((r: LogRecord) => void) | null = null;
const unlistenLogs = vi.fn();
vi.mock('../logs', () => ({
	getLogs: vi.fn(() => Promise.resolve([])),
	subscribeLogs: vi.fn((cb: (r: LogRecord) => void) => {
		logCb = cb;
		return Promise.resolve(unlistenLogs);
	}),
	getLogFilePath: vi.fn(() => Promise.resolve(null)),
	revealLogDir: vi.fn(() => Promise.resolve(true))
}));

// The two overlay helpers the report uses: monitor list (with stable keys) + clipboard.
vi.mock('../overlay', () => ({
	studioMonitorOptions: vi.fn(() => Promise.resolve([])),
	copyToClipboard: vi.fn(() => Promise.resolve(true))
}));

import DiagnosticsPanel from './DiagnosticsPanel';
import {
	getProcessDiagnostics,
	getSubsystemTimings,
	listWindowLabels,
	openDevtoolsFor,
	reloadWindow,
	requestDiagnostics,
	setSubsystemProfiling,
	setWindowInteractive,
	type SubsystemTiming
} from '../diag';
import { resetWidgetProfile, widgetCosts } from './canvas/widgetProfile';
import { getLogFilePath, getLogs, revealLogDir } from '../logs';
import { copyToClipboard, studioMonitorOptions } from '../overlay';
import type { LogRecord } from '../core/logs';

const logRec = (over: Partial<LogRecord> = {}): LogRecord => ({
	ts_ms: 1_700_000_000_000,
	level: 'info',
	target: 'sensors',
	message: 'tick',
	...over
});

// A WindowDiag fixture with sensible defaults; `at` is stamped on the studio clock by the panel
// (it re-stamps performance.now() on arrival), so its exact value here doesn't matter. Heap/art
// bytes are clean powers of 1024 so the formatBytes (binary-scaled) output is exact.
function diag(label: string, over: Partial<WindowDiag> = {}): WindowDiag {
	return {
		label,
		role: label === 'studio' ? 'studio' : label === 'main' ? 'main' : 'overlay',
		monitor: null,
		heap: {
			usedBytes: 50 * 1024 * 1024,
			totalBytes: 80 * 1024 * 1024,
			limitBytes: 200 * 1024 * 1024
		},
		sessions: 1,
		artBytes: 2 * 1024 * 1024,
		sensors: 12,
		activeSensors: 5,
		domNodes: 420,
		widgets: [],
		at: 0,
		...over
	};
}

// Let the mount effect's mocked polls (proc/labels/timings/reports) resolve inside act() so the
// resulting setState commits don't log "not wrapped in act" warnings after the test returns.
const flush = () => act(async () => undefined);

// RTL's default getByText matches one element's normalized text; readouts like `up {duration}` are
// split across literal + interpolated text nodes inside one span, so match on the element's full
// textContent instead. Returns the matched element (throws if absent).
function hasText(container: HTMLElement, text: string): HTMLElement {
	const el = [...container.querySelectorAll<HTMLElement>('span,div,button')].find(
		(e) => e.textContent === text
	);
	if (!el) throw new Error(`no element whose textContent is exactly "${text}"`);
	return el;
}

beforeEach(() => {
	vi.clearAllMocks();
	reportCb = null;
	logCb = null;
	vi.mocked(getLogs).mockResolvedValue([]);
	vi.mocked(getLogFilePath).mockResolvedValue(null);
	vi.mocked(revealLogDir).mockResolvedValue(true);
	vi.mocked(studioMonitorOptions).mockResolvedValue([]);
	vi.mocked(copyToClipboard).mockResolvedValue(true);
	vi.mocked(getProcessDiagnostics).mockResolvedValue(null);
	vi.mocked(getSubsystemTimings).mockResolvedValue([]);
	vi.mocked(listWindowLabels).mockResolvedValue([]);
	vi.mocked(widgetCosts).mockReturnValue([]);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('DiagnosticsPanel lifecycle', () => {
	it('kicks off a poll and enables backend profiling on mount, disabling it on unmount', async () => {
		const { unmount } = render(<DiagnosticsPanel />);
		// The first tick runs synchronously in the mount effect (before the interval).
		expect(requestDiagnostics).toHaveBeenCalled();
		expect(getProcessDiagnostics).toHaveBeenCalled();
		expect(listWindowLabels).toHaveBeenCalled();
		// Demand-gated backend timing: ON while the panel is open.
		await waitFor(() => expect(setSubsystemProfiling).toHaveBeenCalledWith(true));
		unmount();
		expect(setSubsystemProfiling).toHaveBeenCalledWith(false);
	});

	it('re-polls every interval tick (not just the initial mount poll)', async () => {
		vi.useFakeTimers();
		const { unmount } = render(<DiagnosticsPanel />);
		// One poll from the mount effect.
		expect(requestDiagnostics).toHaveBeenCalledTimes(1);
		await act(async () => {
			vi.advanceTimersByTime(1500); // POLL_MS — one interval tick
		});
		expect(requestDiagnostics).toHaveBeenCalledTimes(2);
		unmount();
		// The interval is cleared on unmount: further time advances trigger no more polls.
		await act(async () => {
			vi.advanceTimersByTime(3000);
		});
		expect(requestDiagnostics).toHaveBeenCalledTimes(2);
	});

	it('shows the "Polling windows…" stub when no window has reported and no labels exist', async () => {
		const { getByText } = render(<DiagnosticsPanel />);
		expect(() => getByText(/Polling windows/)).not.toThrow();
		await flush();
	});
});

describe('DiagnosticsPanel native-process row', () => {
	it('renders the host-process cpu / rss / virt / uptime once the proc poll resolves', async () => {
		vi.mocked(getProcessDiagnostics).mockResolvedValue({
			pid: 1234,
			cpuPercent: 7.5,
			memBytes: 256 * 1024 * 1024,
			virtualBytes: 512 * 1024 * 1024,
			uptimeSecs: 3661,
			cpus: 8
		});
		const { findByText, container } = render(<DiagnosticsPanel />);
		expect(await findByText(/pid 1234 · 8 cpus/)).toBeTruthy();
		expect(hasText(container, 'cpu 7.5%')).toBeTruthy();
		expect(hasText(container, 'rss 256.0 MiB')).toBeTruthy();
		expect(hasText(container, 'virt 512.0 MiB')).toBeTruthy();
		// Uptime uses core/timer's formatDuration ('auto' → hh:mm:ss once over an hour), not the
		// compact "1h 1m" form: 3661s → 01:01:01.
		expect(hasText(container, 'up 01:01:01')).toBeTruthy();
		await flush();
	});
});

describe('DiagnosticsPanel backend subsystem timings', () => {
	it('lists the per-subsystem CPU rows from the timings poll', async () => {
		vi.mocked(getSubsystemTimings).mockResolvedValue([
			// One hot subsystem (msPerSec ≥ 5 → data-hot) and one cold one (< 5).
			{ key: 'sensors', avgMs: 6, lastMs: 6.1, samples: 30, perSec: 1, msPerSec: 6 },
			{ key: 'ha', avgMs: 0.5, lastMs: 0.4, samples: 10, perSec: 0.5, msPerSec: 0.25 }
		]);
		const { findByText, getByText, container } = render(<DiagnosticsPanel />);
		expect(await findByText('sensors')).toBeTruthy();
		expect(hasText(container, '6.0 ms/s')).toBeTruthy(); // msPerSec.toFixed(1)
		expect(getByText('ha')).toBeTruthy();
		// The hot row is flagged; the cold row is not.
		expect(container.querySelector('.diag-cost-row[data-hot]')).toBeTruthy();
		expect(container.querySelectorAll('.diag-cost-row[data-hot]').length).toBe(1);
		await flush();
	});

	it('ignores a timings poll that resolves after unmount (alive guard)', async () => {
		// The mount poll's promise is held open past unmount; resolving it then must hit the
		// `if (alive)` bail — no setState on the dead tree (which would warn on console.error).
		let resolveTimings: ((t: SubsystemTiming[]) => void) | undefined;
		vi.mocked(getSubsystemTimings).mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolveTimings = r;
				})
		);
		const { unmount } = render(<DiagnosticsPanel />);
		await flush();
		unmount();
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		await act(async () => {
			resolveTimings?.([
				{ key: 'sensors', avgMs: 1, lastMs: 1, samples: 1, perSec: 1, msPerSec: 1 }
			]);
		});
		expect(errorSpy).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});

describe('DiagnosticsPanel widget render cost', () => {
	it('shows the no-renders stub when nothing has been profiled', async () => {
		const { getByText } = render(<DiagnosticsPanel />);
		expect(() => getByText(/No renders captured yet/)).not.toThrow();
		await flush();
	});

	it('renders cost rows and the reset button clears them', async () => {
		vi.mocked(widgetCosts).mockReturnValue([
			// A churning widget (perSec ≥ 2 → data-hot) and a calm one (< 2 → not flagged).
			{ id: 'clock-ab12', type: 'clock', commits: 4, perSec: 3.2, avgMs: 0.8, lastMs: 0.9 },
			{ id: 'text-cd34', type: 'text', commits: 2, perSec: 0.5, avgMs: 0.2, lastMs: 0.2 }
		]);
		const { getByText, queryByText, container } = render(<DiagnosticsPanel />);
		expect(getByText('clock')).toBeTruthy();
		expect(hasText(container, '3.2/s')).toBeTruthy();
		expect(container.querySelectorAll('.diag-cost-row[data-hot]').length).toBe(1); // only the hot one
		// After reset the accumulator is cleared AND the local rows drop to the empty stub.
		vi.mocked(widgetCosts).mockReturnValue([]);
		fireEvent.click(getByText('reset'));
		expect(resetWidgetProfile).toHaveBeenCalledTimes(1);
		expect(queryByText('clock')).toBeNull();
		expect(getByText(/No renders captured yet/)).toBeTruthy();
		await flush();
	});
});

describe('DiagnosticsPanel window rows', () => {
	it('renders a backend-listed window with its heap / sessions / sensors / dom once it reports', async () => {
		vi.mocked(listWindowLabels).mockResolvedValue(['main']);
		const { findByText, container } = render(<DiagnosticsPanel />);
		// The label row appears from the backend list even before a report arrives.
		expect(await findByText('main')).toBeTruthy();
		// Push a live report (with a monitor key) through the captured listener callback.
		act(() => reportCb?.(diag('main', { monitor: '2' })));
		// heap used/limit + fraction (50/200 MiB → 25%).
		expect(hasText(container, 'heap 50.0 MiB / 200.0 MiB · 25%')).toBeTruthy();
		expect(hasText(container, 'sessions 1 · art 2.0 MiB')).toBeTruthy();
		expect(hasText(container, 'sensors 5/12')).toBeTruthy();
		expect(hasText(container, 'dom 420')).toBeTruthy();
		// The monitor key rides the role line ("· mon 2") when the report carries one.
		expect(container.textContent).toContain('· mon 2');
		await flush();
	});

	it('marks a listed-but-silent window "not responding" and still offers recovery actions', async () => {
		vi.mocked(listWindowLabels).mockResolvedValue(['overlay-2']);
		const { findByText, getByRole } = render(<DiagnosticsPanel />);
		// No report ever arrives for this label → responding:false (report:null).
		expect(await findByText('not responding')).toBeTruthy();
		// Recovery controls (overlay role) reach the backend by label even with no JS report. Use the
		// button role to disambiguate from the explanatory note that also mentions Devtools/Reload.
		fireEvent.click(getByRole('button', { name: /Devtools/ }));
		expect(openDevtoolsFor).toHaveBeenCalledWith('overlay-2');
		fireEvent.click(getByRole('button', { name: /Reload/ }));
		expect(reloadWindow).toHaveBeenCalledWith('overlay-2');
		await flush();
	});

	it('toggling "interactive" drops click-through for that window via the backend', async () => {
		vi.mocked(listWindowLabels).mockResolvedValue(['overlay-2']);
		const { findByText, getByLabelText } = render(<DiagnosticsPanel />);
		await findByText('overlay-2');
		const box = getByLabelText('interactive') as HTMLInputElement;
		expect(box.checked).toBe(false);
		fireEvent.click(box);
		expect(setWindowInteractive).toHaveBeenCalledWith('overlay-2', true);
		expect(box.checked).toBe(true);
		await flush();
	});

	it('does not offer recovery actions for the studio window itself', async () => {
		vi.mocked(listWindowLabels).mockResolvedValue(['studio']);
		const { findByText, queryByRole } = render(<DiagnosticsPanel />);
		await findByText('studio');
		act(() => reportCb?.(diag('studio')));
		expect(queryByRole('button', { name: /Devtools/ })).toBeNull();
		expect(queryByRole('button', { name: /Reload/ })).toBeNull();
		await flush();
	});

	it('renders the per-widget DOM breakdown when a report carries one', async () => {
		vi.mocked(listWindowLabels).mockResolvedValue(['main']);
		const { findByText, getByText } = render(<DiagnosticsPanel />);
		await findByText('main');
		act(() =>
			reportCb?.(
				diag('main', {
					widgets: [
						{ type: 'cpu', count: 2, nodes: 64 },
						{ type: 'clock', count: 1, nodes: 8 }
					]
				})
			)
		);
		expect(getByText(/cpu×2/)).toBeTruthy();
		expect(getByText('64')).toBeTruthy();
		await flush();
	});

	it('ignores a report that arrives after the panel unmounts (alive guard)', async () => {
		vi.mocked(listWindowLabels).mockResolvedValue(['main']);
		const { findByText, unmount } = render(<DiagnosticsPanel />);
		await findByText('main');
		unmount();
		// The listener's `if (!alive) return` short-circuits — pushing a report must not throw or
		// attempt a setState on the unmounted tree.
		expect(() => act(() => reportCb?.(diag('main')))).not.toThrow();
	});

	it('renders heap "n/a" when a window reports no heap stats', async () => {
		vi.mocked(listWindowLabels).mockResolvedValue(['main']);
		const { findByText, container } = render(<DiagnosticsPanel />);
		await findByText('main');
		act(() => reportCb?.(diag('main', { heap: null })));
		// The heap branch falls back to 'n/a' and drops the % fraction.
		expect(hasText(container, 'heap n/a')).toBeTruthy();
		await flush();
	});
});

describe('DiagnosticsPanel logs pane', () => {
	const backlog = [
		logRec({ level: 'debug', target: 'sensors', message: 'debug noise' }),
		logRec({ level: 'warn', target: 'ha', message: 'ha warned' }),
		logRec({ level: 'info', target: 'watchdog', message: 'stall 900ms' }),
		logRec({
			level: 'info',
			target: 'client',
			fields: { component: 'overlay', window: 'main' },
			message: 'refit start (main)'
		})
	];

	it('shows warn+ from the backlog by default, and lets the level filter widen it', async () => {
		vi.mocked(getLogs).mockResolvedValue(backlog);
		const { findByText, queryByText, getByLabelText, container } = render(<DiagnosticsPanel />);
		expect(await findByText(/ha: ha warned/)).toBeTruthy();
		expect(queryByText(/debug noise/)).toBeNull();
		expect(queryByText(/stall 900ms/)).toBeNull();
		expect(hasText(container, '1 shown · 4 buffered')).toBeTruthy();
		fireEvent.change(getByLabelText('Minimum log level'), { target: { value: 'debug' } });
		expect(queryByText(/debug noise/)).toBeTruthy();
		expect(queryByText(/stall 900ms/)).toBeTruthy();
		await flush();
	});

	it('quick chips narrow to their target (+ component) and toggle off again', async () => {
		vi.mocked(getLogs).mockResolvedValue(backlog);
		const { findByText, getByLabelText, getByRole, queryByText } = render(<DiagnosticsPanel />);
		await findByText(/ha warned/);
		fireEvent.change(getByLabelText('Minimum log level'), { target: { value: 'trace' } });
		const watchdog = getByRole('button', { name: 'watchdog' });
		fireEvent.click(watchdog);
		expect(watchdog.getAttribute('aria-pressed')).toBe('true');
		expect(queryByText(/stall 900ms/)).toBeTruthy();
		expect(queryByText(/ha warned/)).toBeNull();
		// The client chip requires the overlay component.
		fireEvent.click(getByRole('button', { name: 'client · overlay' }));
		expect(queryByText(/refit start/)).toBeTruthy();
		expect(queryByText(/stall 900ms/)).toBeNull();
		// Clicking the active chip clears it → everything at trace+ is back.
		fireEvent.click(getByRole('button', { name: 'client · overlay' }));
		expect(queryByText(/stall 900ms/)).toBeTruthy();
		expect(queryByText(/ha warned/)).toBeTruthy();
		await flush();
	});

	it('the target text filter matches targets and clears any chip', async () => {
		vi.mocked(getLogs).mockResolvedValue(backlog);
		const { findByText, getByLabelText, getByRole, queryByText } = render(<DiagnosticsPanel />);
		await findByText(/ha warned/);
		fireEvent.change(getByLabelText('Minimum log level'), { target: { value: 'trace' } });
		fireEvent.click(getByRole('button', { name: 'watchdog' }));
		fireEvent.change(getByLabelText('Filter by target'), { target: { value: 'ha' } });
		expect(getByRole('button', { name: 'watchdog' }).getAttribute('aria-pressed')).toBe('false');
		expect(queryByText(/ha warned/)).toBeTruthy();
		expect(queryByText(/stall 900ms/)).toBeNull();
		await flush();
	});

	it('appends live records from the stream and shows the empty stub when nothing matches', async () => {
		const { findByText, queryByText, unmount } = render(<DiagnosticsPanel />);
		expect(await findByText('No log lines match.')).toBeTruthy();
		act(() => logCb?.(logRec({ level: 'error', target: 'panic', message: 'boom' })));
		expect(queryByText(/panic: boom/)).toBeTruthy();
		unmount();
		await flush();
		expect(unlistenLogs).toHaveBeenCalled();
		// After unmount the alive guard drops late records without a setState on the dead tree.
		expect(() => logCb?.(logRec({ level: 'error', message: 'late' }))).not.toThrow();
	});

	it('ignores a backlog / log-path read that resolves after unmount (alive guard)', async () => {
		let resolveLogs: ((l: LogRecord[]) => void) | undefined;
		let resolvePath: ((p: string | null) => void) | undefined;
		vi.mocked(getLogs).mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolveLogs = r;
				})
		);
		vi.mocked(getLogFilePath).mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolvePath = r;
				})
		);
		const { unmount } = render(<DiagnosticsPanel />);
		await flush();
		unmount();
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		await act(async () => {
			resolveLogs?.([logRec({ level: 'error', message: 'late' })]);
			resolvePath?.('C:/late.log');
		});
		expect(errorSpy).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it('shows the log file path and opens the folder via the backend', async () => {
		vi.mocked(getLogFilePath).mockResolvedValue('C:/logs/widgetsack.log');
		const { findByText, getByRole } = render(<DiagnosticsPanel />);
		expect(await findByText('C:/logs/widgetsack.log')).toBeTruthy();
		fireEvent.click(getByRole('button', { name: /Open log folder/ }));
		expect(revealLogDir).toHaveBeenCalledTimes(1);
		await flush();
	});

	it('"Copy diagnostics" composes the report from version, monitors, process and logs', async () => {
		vi.mocked(getLogs).mockResolvedValue(backlog);
		vi.mocked(getLogFilePath).mockResolvedValue('C:/logs/widgetsack.log');
		vi.mocked(studioMonitorOptions).mockResolvedValue([
			{ key: 'default', label: 'DISPLAY1 (primary)', name: 'DISPLAY1', w: 1920, h: 1080 }
		]);
		vi.mocked(getProcessDiagnostics).mockResolvedValue({
			pid: 7,
			cpuPercent: 1,
			memBytes: 1048576,
			virtualBytes: 2097152,
			uptimeSecs: 5,
			cpus: 4
		});
		const { findByText, getByRole } = render(<DiagnosticsPanel appVersion="9.9.9" />);
		await findByText(/ha warned/);
		await findByText(/pid 7/);
		fireEvent.click(getByRole('button', { name: /Copy diagnostics/ }));
		expect(await findByText('copied')).toBeTruthy();
		const text = vi.mocked(copyToClipboard).mock.calls[0][0];
		expect(text).toContain('widgetsack diagnostics · v9.9.9');
		expect(text).toContain('log file: C:/logs/widgetsack.log');
		expect(text).toContain('- default: DISPLAY1 (primary) [DISPLAY1 1920×1080]');
		expect(text).toContain('pid 7 ·');
		// Trace lines (watchdog + overlay refit) ride along regardless of level; debug noise does not.
		expect(text).toContain('watchdog: stall 900ms');
		expect(text).toContain('client: refit start (main) component=overlay window=main');
		expect(text).toContain('ha: ha warned');
		expect(text).not.toContain('debug noise');
	});

	it('reports a failed copy and tolerates a missing monitor bridge', async () => {
		vi.mocked(studioMonitorOptions).mockRejectedValue(new Error('no tauri'));
		vi.mocked(copyToClipboard).mockResolvedValue(false);
		const { findByText, getByRole } = render(<DiagnosticsPanel />);
		fireEvent.click(getByRole('button', { name: /Copy diagnostics/ }));
		expect(await findByText('copy failed')).toBeTruthy();
		expect(vi.mocked(copyToClipboard).mock.calls[0][0]).toContain('(none reported)');
	});
});
