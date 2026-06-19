import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyLlmStudioOps, llmStudioMonitor, llmStudioReady, setLlmStudioApi } from './llm-studio';
import type { StudioApi, StudioApplyResult } from '../plugin';
import type { MonitorLayout } from '../../core/layoutTree';

// Reset the module-level api slot between tests so each starts from "no studio mounted".
afterEach(() => setLlmStudioApi(null));

const monitor = { id: 'm', root: { kind: 'frame', children: [] } } as unknown as MonitorLayout;

function fakeApi(over: Partial<StudioApi> = {}): StudioApi {
	return {
		monitor: () => monitor,
		apply: (): StudioApplyResult => ({ applied: 2, addedIds: ['a', 'b'], errors: [] }),
		...over
	};
}

describe('llm-studio bridge', () => {
	it('reports not-ready and degrades gracefully when no studio is mounted', () => {
		expect(llmStudioReady()).toBe(false);
		expect(llmStudioMonitor()).toBeNull();
		expect(applyLlmStudioOps([])).toEqual({
			applied: 0,
			addedIds: [],
			errors: ['the editor is not ready']
		});
	});

	it('reports ready and proxies through to the stashed api once set', () => {
		const apply = vi.fn((): StudioApplyResult => ({ applied: 1, addedIds: ['x'], errors: [] }));
		setLlmStudioApi(fakeApi({ apply }));

		expect(llmStudioReady()).toBe(true);
		expect(llmStudioMonitor()).toBe(monitor);

		const ops = [{ kind: 'noop' }] as unknown as Parameters<typeof applyLlmStudioOps>[0];
		expect(applyLlmStudioOps(ops)).toEqual({ applied: 1, addedIds: ['x'], errors: [] });
		expect(apply).toHaveBeenCalledWith(ops);
	});

	it('clearing the api returns to the degraded path', () => {
		setLlmStudioApi(fakeApi());
		expect(llmStudioReady()).toBe(true);
		setLlmStudioApi(null);
		expect(llmStudioReady()).toBe(false);
		expect(llmStudioMonitor()).toBeNull();
	});
});
