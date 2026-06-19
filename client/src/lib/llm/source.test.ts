import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Outer-ring Tauri adapter for streamed LLM tokens. We mock @tauri-apps/api/event's `listen` and the
// store's pure `handleDelta` so the reference-counting + attach race can be exercised without a Tauri
// runtime or a real store. Module-level refcount state is reset per test via vi.resetModules() +
// dynamic import.

const handleDelta = vi.fn();
vi.mock('../../stores/llmStore', () => ({ handleDelta: (...a: unknown[]) => handleDelta(...a) }));

// `listen` is reconfigured per test. By default it resolves immediately to a spy unlisten fn.
const unlistenSpy = vi.fn();
let listen: ReturnType<typeof vi.fn>;
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listen(...a) }));

type Source = typeof import('./source');
const load = async (): Promise<Source> => {
	vi.resetModules();
	return import('./source');
};

beforeEach(() => {
	vi.clearAllMocks();
	unlistenSpy.mockClear();
	listen = vi.fn(() => Promise.resolve(unlistenSpy));
});
afterEach(() => vi.restoreAllMocks());

describe('startLlmSource', () => {
	it('exposes the llm_delta event name from the bridge contract', async () => {
		const mod = await load();
		expect(mod.LLM_DELTA_EVENT).toBe('llm_delta');
	});

	it('attaches one listener that folds each delta into the store via the reducer', async () => {
		const mod = await load();
		const stop = await mod.startLlmSource();
		expect(listen).toHaveBeenCalledTimes(1);
		expect(listen.mock.calls[0][0]).toBe('llm_delta');

		// Drive the registered handler with a frame → it forwards the payload to handleDelta.
		const handler = listen.mock.calls[0][1] as (ev: { payload: unknown }) => void;
		handler({ payload: { id: 'r1', text: 'hi' } });
		expect(handleDelta).toHaveBeenCalledWith({ id: 'r1', text: 'hi' });

		stop();
		expect(unlistenSpy).toHaveBeenCalledTimes(1);
	});

	it('reference-counts: the listener attaches once and detaches only when the last consumer stops', async () => {
		const mod = await load();
		const stopA = await mod.startLlmSource();
		const stopB = await mod.startLlmSource();
		// Second consumer reuses the live listener — no second attach.
		expect(listen).toHaveBeenCalledTimes(1);

		stopA();
		expect(unlistenSpy).not.toHaveBeenCalled(); // B still holds a ref
		stopB();
		expect(unlistenSpy).toHaveBeenCalledTimes(1); // last consumer → detach
	});

	it('per-call stop fn is idempotent (a double-stop does not over-decrement)', async () => {
		const mod = await load();
		const stopA = await mod.startLlmSource();
		const stopB = await mod.startLlmSource();
		stopA();
		stopA(); // idempotent: must NOT release B's ref
		expect(unlistenSpy).not.toHaveBeenCalled();
		stopB();
		expect(unlistenSpy).toHaveBeenCalledTimes(1);
	});

	it('reuses the in-flight attach: a second consumer started mid-attach does not re-listen', async () => {
		// Defer the listen() resolution so a second consumer arrives while the attach is in flight.
		let resolveListen: (u: () => void) => void = () => undefined;
		listen = vi.fn(() => new Promise<() => void>((res) => (resolveListen = res)));

		const mod = await load();
		const p1 = mod.startLlmSource(); // refs = 1, attach in flight
		const p2 = mod.startLlmSource(); // refs = 2, sees `attaching` → shares it, no 2nd listen()
		expect(listen).toHaveBeenCalledTimes(1);

		resolveListen(unlistenSpy);
		const [stop1, stop2] = await Promise.all([p1, p2]);
		// Still one listener; it detaches only after BOTH stop.
		stop1();
		expect(unlistenSpy).not.toHaveBeenCalled();
		stop2();
		expect(unlistenSpy).toHaveBeenCalledTimes(1);
	});

	it('keeps running silently when there is no Tauri runtime (listen rejects)', async () => {
		listen = vi.fn(() => Promise.reject(new Error('no tauri')));
		const mod = await load();
		const stop = await mod.startLlmSource();
		// No listener attached, but the stop fn is still safe to call.
		expect(() => stop()).not.toThrow();
		expect(unlistenSpy).not.toHaveBeenCalled();
	});
});
