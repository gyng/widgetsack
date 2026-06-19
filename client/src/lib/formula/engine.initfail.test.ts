import { afterEach, describe, expect, it, vi } from 'vitest';

// Drive initFormulaEngine's failure path (the `.catch` that logs and leaves the engine not-ready)
// by making the WASM module loader reject. Isolated in its OWN file so the module mock + the
// engine singleton it builds on don't bleed into engine.test.ts (which uses the real runtime).
vi.mock('quickjs-emscripten-core', () => ({
	newQuickJSWASMModuleFromVariant: vi.fn(async () => {
		throw new Error('wasm boom');
	})
}));
vi.mock('@jitl/quickjs-singlefile-browser-release-sync', () => ({ default: {} }));

describe('initFormulaEngine — load failure', () => {
	afterEach(() => vi.restoreAllMocks());

	it('logs and stays not-ready when the WASM module fails to load (never rejects)', async () => {
		const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { initFormulaEngine, isFormulaEngineReady, evalExpr } = await import('./engine');
		// must RESOLVE (the catch swallows the rejection) rather than throw
		await expect(initFormulaEngine()).resolves.toBeUndefined();
		expect(isFormulaEngineReady()).toBe(false);
		expect(evalExpr('1 + 1', {})).toBeNull(); // not-ready guard
		expect(err).toHaveBeenCalledWith('[formula] engine init failed', expect.any(Error));
	});
});
