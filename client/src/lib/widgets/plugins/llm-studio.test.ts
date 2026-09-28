import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureLlmStudioTarget, llmStudioReady, setLlmStudioApi } from './llm-studio';
import type { StudioApi, StudioApplyResult } from '../plugin';
import { emptyMonitorLayout } from '../../core/layoutTree';

// Reset the module-level api slot between tests so each starts from "no studio mounted".
afterEach(() => setLlmStudioApi(null));

const monitor = emptyMonitorLayout();

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
		expect(captureLlmStudioTarget()).toBeNull();
	});

	it('reports ready and proxies through to the stashed api once set', () => {
		const apply = vi.fn((): StudioApplyResult => ({ applied: 1, addedIds: ['x'], errors: [] }));
		setLlmStudioApi(fakeApi({ apply }));

		expect(llmStudioReady()).toBe(true);
		const target = captureLlmStudioTarget()!;
		expect(target.monitor).toBe(monitor);

		const ops: Parameters<typeof target.apply>[0] = [{ op: 'clear' }];
		expect(target.apply(ops)).toEqual({ applied: 1, addedIds: ['x'], errors: [] });
		expect(apply).toHaveBeenCalledWith(ops);
	});

	it('clearing the api returns to the degraded path', () => {
		setLlmStudioApi(fakeApi());
		expect(llmStudioReady()).toBe(true);
		setLlmStudioApi(null);
		expect(llmStudioReady()).toBe(false);
		expect(captureLlmStudioTarget()).toBeNull();
	});
});

it('refuses generated edits after the captured monitor changes or editor is replaced', () => {
	let current = monitor;
	const apply = vi.fn();
	const api = fakeApi({ monitor: () => current, apply });
	setLlmStudioApi(api);
	const target = captureLlmStudioTarget()!;
	current = { ...monitor };
	expect(target.apply([{ op: 'clear' }]).applied).toBe(0);
	expect(apply).not.toHaveBeenCalled();
	current = monitor;
	setLlmStudioApi(fakeApi({ apply }));
	expect(target.apply([{ op: 'clear' }]).applied).toBe(0);
	expect(apply).not.toHaveBeenCalled();
});
