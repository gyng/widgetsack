import { beforeEach, describe, expect, it, vi } from 'vitest';

// The plugin's readiness source reads the non-secret config command, and its studio hook stashes the
// editor api. Mock the command + the seam helpers so both can be exercised without a backend/studio.
const llmConfigStatus = vi.fn();
vi.mock('./llm-commands', async (importOriginal) => ({
	...(await importOriginal<typeof import('./llm-commands')>()),
	llmConfigStatus: (...a: unknown[]) => llmConfigStatus(...a)
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

describe('llm (ai-provider) plugin', () => {
	it('registers the assistant + transcribe widgets', () => {
		expect(getMeta('assistant')).toBeTruthy();
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
