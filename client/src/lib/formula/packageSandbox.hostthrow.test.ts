// evalJson's last-resort catch: a hostile script THROWS a value so deep that dumping the error
// object host-side (ctx.dump(out.error)) explodes — the tick must come back as { ok:false },
// never as an exception. Kept in its OWN file with NO dispose calls: the aborted dump strands
// QuickJS handles, and disposing that runtime would trip QuickJS's leak assertion — the vitest
// worker teardown reclaims the WASM instance instead. (packageSandbox.test.ts owns the normal
// create/dispose lifecycle.)
import { describe, expect, it } from 'vitest';
import { createPackageSandbox } from './packageSandbox';

// requests() throws a 100k-deep nested array (built iteratively — no sandbox recursion): QuickJS
// propagates the value as the eval error, and serializing it back to the host blows the dump.
const THROW_DEEP_SCRIPT = `
module.exports = {
	requests: function () {
		var a = []; var cur = a;
		for (var i = 0; i < 100000; i++) { var n = []; cur.push(n); cur = n; }
		throw a;
	},
	transform: function () { return []; }
};
`;

describe('package sandbox — host-side dump failure', () => {
	it('reports ok:false when the thrown error value cannot be brought across', async () => {
		const r = await createPackageSandbox(THROW_DEEP_SCRIPT);
		expect(r.ok).toBe(true);
		if (!r.ok) return;

		const out = r.sandbox.requests();
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error.length).toBeGreaterThan(0);
		// The sandbox survives for subsequent, well-behaved calls on the same runtime.
		expect(r.sandbox.transform([])).toEqual({ ok: true, value: [] });
	});
});
