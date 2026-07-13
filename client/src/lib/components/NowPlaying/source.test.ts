import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	listen: vi.fn(),
	handleInitialize: vi.fn(),
	handleUpdate: vi.fn(),
	handleDelete: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../../../stores/stores', () => ({
	handleInitialize: mocks.handleInitialize,
	handleUpdate: mocks.handleUpdate,
	handleDelete: mocks.handleDelete
}));

import { EVENTS } from '../../bridge/contract';
import type { SessionRecord } from '../../../stores/stores';

type EventCallback = (event: { payload: SessionRecord }) => void;

const record = (sessionId: number): SessionRecord => ({
	session_id: sessionId,
	source: 'player.exe',
	timestamp_created: null,
	timestamp_updated: null,
	last_media_update: null,
	last_model_update: null
});

async function loadSource() {
	vi.resetModules();
	return import('./source');
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('startMediaSource', () => {
	it('attaches every listener first, then initializes and replays deltas received during the snapshot', async () => {
		const callbacks = new Map<string, EventCallback>();
		mocks.listen.mockImplementation((event: string, callback: EventCallback) => {
			callbacks.set(event, callback);
			return Promise.resolve(vi.fn());
		});
		let resolveInitial!: (value: { sessions: Record<number, SessionRecord> }) => void;
		mocks.invoke.mockImplementation(
			() =>
				new Promise<{ sessions: Record<number, SessionRecord> }>((resolve) => {
					resolveInitial = resolve;
				})
		);
		const { startMediaSource } = await loadSource();

		const starting = startMediaSource();
		expect(mocks.listen.mock.calls.map((call) => call[0])).toEqual([
			EVENTS.sessionCreate,
			EVENTS.sessionUpdate,
			EVENTS.sessionDelete
		]);
		expect(mocks.invoke).not.toHaveBeenCalled();
		await Promise.resolve();
		await Promise.resolve();
		expect(mocks.invoke).toHaveBeenCalledOnce();

		callbacks.get(EVENTS.sessionUpdate)!({ payload: record(2) });
		expect(mocks.handleUpdate).not.toHaveBeenCalled();
		resolveInitial({ sessions: { 1: record(1) } });
		await starting;

		expect(mocks.handleInitialize).toHaveBeenCalledWith({ sessions: { 1: record(1) } });
		expect(mocks.handleUpdate).toHaveBeenCalledWith({ sessionRecord: record(2) });
		expect(mocks.handleInitialize.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.handleUpdate.mock.invocationCallOrder[0]!
		);
	});

	it('treats create as an upsert and applies live deletes after initialization', async () => {
		const callbacks = new Map<string, EventCallback>();
		mocks.listen.mockImplementation((event: string, callback: EventCallback) => {
			callbacks.set(event, callback);
			return Promise.resolve(vi.fn());
		});
		mocks.invoke.mockResolvedValue({ sessions: {} });
		const { startMediaSource } = await loadSource();
		await startMediaSource();

		callbacks.get(EVENTS.sessionCreate)!({ payload: record(3) });
		callbacks.get(EVENTS.sessionDelete)!({ payload: record(3) });
		expect(mocks.handleUpdate).toHaveBeenCalledWith({ sessionRecord: record(3) });
		expect(mocks.handleDelete).toHaveBeenCalledWith({ sessionRecord: record(3) });
	});

	it('cleans up partial listeners and allows a retry after listener setup fails', async () => {
		const unlistenA = vi.fn();
		const unlistenB = vi.fn();
		mocks.listen
			.mockResolvedValueOnce(unlistenA)
			.mockRejectedValueOnce(new Error('event bridge unavailable'))
			.mockResolvedValueOnce(unlistenB);
		mocks.invoke.mockResolvedValue({ sessions: {} });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { startMediaSource } = await loadSource();

		await startMediaSource();
		expect(unlistenA).toHaveBeenCalledOnce();
		expect(unlistenB).toHaveBeenCalledOnce();
		expect(mocks.invoke).not.toHaveBeenCalled();

		mocks.listen.mockResolvedValue(vi.fn());
		await startMediaSource();
		expect(mocks.listen).toHaveBeenCalledTimes(6);
		expect(mocks.invoke).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith('Could not start the media event source', expect.any(Error));
	});

	it('keeps the live feed when only the initial snapshot fails', async () => {
		const callbacks = new Map<string, EventCallback>();
		mocks.listen.mockImplementation((event: string, callback: EventCallback) => {
			callbacks.set(event, callback);
			return Promise.resolve(vi.fn());
		});
		mocks.invoke.mockRejectedValue(new Error('snapshot unavailable'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { startMediaSource } = await loadSource();
		await startMediaSource();

		callbacks.get(EVENTS.sessionUpdate)!({ payload: record(4) });
		expect(mocks.handleUpdate).toHaveBeenCalledWith({ sessionRecord: record(4) });
		expect(warn).toHaveBeenCalledWith(
			'Could not load the initial media sessions',
			expect.any(Error)
		);
	});
});
