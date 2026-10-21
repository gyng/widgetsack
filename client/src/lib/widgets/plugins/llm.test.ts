import { beforeEach, describe, expect, it, vi } from 'vitest';

// The plugin's readiness source reads the non-secret config command, and its studio hook stashes the
// editor api. Mock the command + the seam helpers so both can be exercised without a backend/studio.
const llmConfigStatus = vi.fn();
const subscribe = vi.fn(async (_changed: () => void) => () => {});
vi.mock('./llm-commands', async (importOriginal) => ({
	...(await importOriginal<typeof import('./llm-commands')>()),
	llmConfigStatus: (...a: unknown[]) => llmConfigStatus(...a),
	onLlmConfigChanged: (changed: () => void) => subscribe(changed)
}));
vi.mock('./llm-status', async (importOriginal) => ({
	...(await importOriginal<typeof import('./llm-status')>()),
	ingestLlmStatus: vi.fn()
}));
vi.mock('./llm-studio', async (importOriginal) => ({
	...(await importOriginal<typeof import('./llm-studio')>()),
	setLlmStudioApi: vi.fn()
}));

import { registerLlmPlugin } from './llm';
import { listPlugins, type StudioApi } from '../plugin';
import { getMeta } from '../../core/widget';
import { createTelemetryHub } from '../../core/telemetry';
import { ingestLlmStatus } from './llm-status';
import { setLlmStudioApi } from './llm-studio';

registerLlmPlugin();

const plugin = () => {
	const p = listPlugins().find((x) => x.id === 'ai-provider');
	if (!p) throw new Error('ai-provider plugin not registered');
	return p;
};

beforeEach(() => vi.clearAllMocks());

it('refreshes AI readiness after configuration changes and ignores stale/unmounted results', async () => {
	const source = plugin().sources!.find((source) => source.id === 'ai-provider')!;
	llmConfigStatus.mockResolvedValueOnce({ configured: false });
	const stop = await source.start(createTelemetryHub());
	const changed = subscribe.mock.calls.at(-1)![0];
	let old!: (value: unknown) => void;
	llmConfigStatus.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				old = resolve;
			})
	);
	changed();
	llmConfigStatus.mockResolvedValueOnce({ configured: true, active: 'ollama' });
	changed();
	await vi.waitFor(() =>
		expect(ingestLlmStatus).toHaveBeenLastCalledWith(expect.anything(), {
			configured: true,
			active: 'ollama'
		})
	);
	const calls = vi.mocked(ingestLlmStatus).mock.calls.length;
	old({ configured: false });
	await Promise.resolve();
	expect(ingestLlmStatus).toHaveBeenCalledTimes(calls);
	let pending!: (value: unknown) => void;
	llmConfigStatus.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				pending = resolve;
			})
	);
	changed();
	stop();
	pending({ configured: false });
	await Promise.resolve();
	expect(ingestLlmStatus).toHaveBeenCalledTimes(calls);
});
it('still loads readiness when the optional event bridge is unavailable', async () => {
	subscribe.mockRejectedValueOnce(new Error('no event bridge'));
	llmConfigStatus.mockResolvedValueOnce({ configured: true });
	const source = plugin().sources!.find((source) => source.id === 'ai-provider')!;
	const stop = await source.start(createTelemetryHub());
	expect(ingestLlmStatus).toHaveBeenCalledWith(expect.anything(), { configured: true });
	stop();
});

describe('llm (ai-provider) plugin', () => {
	it('distinguishes scheduled prompts from interactive chats while preserving saved type IDs', () => {
		expect(getMeta('assistant')?.label).toBe('AI Prompt');
		expect(getMeta('aichat')?.label).toBe('AI Chat');
		expect(getMeta('assistant')?.defaultConfig).toMatchObject({
			schedule: '10m',
			label: 'AI Prompt'
		});
		expect(getMeta('aichat')?.defaultConfig).toEqual({ label: 'AI Chat' });
		expect(getMeta('aichat')?.interactive).toBe(true);
		expect(getMeta('transcribe')).toBeTruthy();
	});

	it('assistant widget exposes a speak (TTS) toggle', () => {
		const keys = (getMeta('assistant')?.configFields ?? []).map((f) => f.key);
		expect(keys).toContain('speak');
	});

	it('declares the llm.status sensor as the plugins-list status dot', () => {
		expect(plugin().statusSensor).toBe('llm.status');
	});

	describe('the llm.status readiness source', () => {
		const source = () => {
			const s = plugin().sources?.find((x) => x.id === 'ai-provider');
			if (!s) throw new Error('ai-provider source not registered');
			return s;
		};

		it('catalogs the llm.status sensor', () => {
			expect(source().catalog?.()).toEqual(['llm.status']);
			expect(source().catalogEntries?.()).toEqual([
				{ id: 'llm.status', label: 'AI provider status' }
			]);
		});

		it('ingests one readiness sample at start from the config command', async () => {
			const status = { configured: true, active: 'openai', providers: {} };
			llmConfigStatus.mockResolvedValue(status);
			const hub = createTelemetryHub();
			const stop = await source().start(hub);
			expect(ingestLlmStatus).toHaveBeenCalledWith(hub, status);
			// The returned stop fn is a no-op (the dot is event-driven, not a live listener).
			expect(stop()).toBeUndefined();
		});

		it('stays silent when the command is unavailable (no backend)', async () => {
			llmConfigStatus.mockRejectedValue(new Error('no backend'));
			const hub = createTelemetryHub();
			const stop = await source().start(hub);
			expect(ingestLlmStatus).not.toHaveBeenCalled();
			expect(stop()).toBeUndefined();
		});
	});

	describe('the studio capability', () => {
		it('stashes the editor api on mount and drops it on cleanup', () => {
			const api = { monitor: vi.fn(), apply: vi.fn() } as unknown as StudioApi;
			const studio = plugin().studio;
			if (!studio) throw new Error('no studio hook');
			const cleanup = studio(api);
			expect(setLlmStudioApi).toHaveBeenCalledWith(api);

			if (typeof cleanup !== 'function') throw new Error('studio hook returns no cleanup');
			cleanup();
			expect(setLlmStudioApi).toHaveBeenLastCalledWith(null);
		});
	});
});
