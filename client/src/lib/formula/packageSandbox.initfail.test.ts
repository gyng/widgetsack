import { describe, expect, it, vi } from 'vitest';

// Drive createPackageSandbox's init-failure path (the runtime can't be built) by making the shared
// WASM module loader reject. Isolated in its own file so the module mock doesn't bleed into
// packageSandbox.test.ts (which uses the real runtime).
vi.mock('./engine', () => ({
	loadQuickJSModule: vi.fn(async () => {
		throw new Error('wasm load boom');
	})
}));

describe('createPackageSandbox — init failure', () => {
	it('returns { ok:false, error } (never throws) when the runtime cannot be built', async () => {
		const { createPackageSandbox } = await import('./packageSandbox');
		const r = await createPackageSandbox(`module.exports = { requests(){}, transform(){} };`);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toContain('sandbox init failed');
		expect(r.error).toContain('wasm load boom');
	});
});
