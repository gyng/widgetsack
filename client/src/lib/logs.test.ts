import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Outer-ring Tauri adapter for the backend structured log stream (widgetsack/src/log.rs). We mock
// @tauri-apps/api's `invoke`/`listen` so the backlog fetch + live-stream subscription can be
// exercised without a Tauri runtime. The module is re-imported per test so the mocks bind cleanly.

const invoke = vi.fn();
const listen = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listen(...a) }));

type Logs = typeof import('./logs');
const load = async (): Promise<Logs> => {
	vi.resetModules();
	return import('./logs');
};

const sample = (
	over: Partial<import('./core/logs').LogRecord> = {}
): import('./core/logs').LogRecord => ({
	ts_ms: 1_700_000_000_000,
	level: 'info',
	target: 'sensors',
	message: 'hello',
	...over
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('getLogs', () => {
	it('invokes get_logs and resolves the backlog', async () => {
		const backlog = [sample(), sample({ level: 'warn', message: 'careful' })];
		invoke.mockResolvedValueOnce(backlog);
		const { getLogs } = await load();
		await expect(getLogs()).resolves.toEqual(backlog);
		expect(invoke).toHaveBeenCalledWith('get_logs');
	});

	it('resolves to an empty array when the command rejects', async () => {
		invoke.mockRejectedValueOnce(new Error('backend down'));
		const { getLogs } = await load();
		await expect(getLogs()).resolves.toEqual([]);
	});
});

describe('subscribeLogs', () => {
	it('listens on the log event and forwards each payload to the callback', async () => {
		const unlisten = vi.fn();
		listen.mockResolvedValueOnce(unlisten);
		const cb = vi.fn();
		const { subscribeLogs } = await load();
		const stop = await subscribeLogs(cb);

		expect(listen).toHaveBeenCalledTimes(1);
		expect(listen.mock.calls[0][0]).toBe('log');

		// Drive the registered handler with an event → the bare payload reaches the callback.
		const handler = listen.mock.calls[0][1] as (ev: { payload: unknown }) => void;
		const record = sample({ target: 'bridge', message: 'connected' });
		handler({ payload: record });
		expect(cb).toHaveBeenCalledWith(record);

		// returns the unlisten fn straight through
		expect(stop).toBe(unlisten);
	});
});

describe('getLogFilePath / revealLogDir', () => {
	it('resolves the backend path, or null when the command is unavailable', async () => {
		invoke.mockResolvedValueOnce('C:/logs/widgetsack.log');
		const { getLogFilePath } = await load();
		await expect(getLogFilePath()).resolves.toBe('C:/logs/widgetsack.log');
		expect(invoke).toHaveBeenCalledWith('log_file_path');
		invoke.mockRejectedValueOnce(new Error('no tauri'));
		await expect(getLogFilePath()).resolves.toBeNull();
	});

	it('asks the backend to reveal the log dir and reports success / failure', async () => {
		invoke.mockResolvedValueOnce(undefined);
		const { revealLogDir } = await load();
		await expect(revealLogDir()).resolves.toBe(true);
		expect(invoke).toHaveBeenCalledWith('reveal_log_dir');
		invoke.mockRejectedValueOnce(new Error('explorer missing'));
		await expect(revealLogDir()).resolves.toBe(false);
	});
});
