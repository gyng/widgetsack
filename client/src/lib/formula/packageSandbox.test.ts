import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { __disposeFormulaEngine, initFormulaEngine } from './engine';
import { createPackageSandbox, type SandboxResponse } from './packageSandbox';

// The package sandbox builds its runtime from the SAME shared WASM module as the formula engine,
// so prime that load once up front and tear it down after (engine.ts owns the module cache).
beforeAll(async () => {
	await initFormulaEngine();
});
afterAll(() => __disposeFormulaEngine());

// A well-formed source.js: returns two https URLs from requests(), maps the bodies in transform().
const GOOD_SCRIPT = `
module.exports = {
	requests: function () { return ['https://a.example/1', 'https://b.example/2']; },
	transform: function (responses) {
		return responses.map(function (r) {
			return { sensor: 'status.' + r.status, value: r.body.length };
		});
	}
};
`;

describe('createPackageSandbox', () => {
	it('compiles a valid source and round-trips requests() / transform() as JSON', async () => {
		const r = await createPackageSandbox(GOOD_SCRIPT);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const sb = r.sandbox;

		const req = sb.requests();
		expect(req).toEqual({ ok: true, value: ['https://a.example/1', 'https://b.example/2'] });

		const responses: SandboxResponse[] = [
			{ url: 'https://a.example/1', status: 200, body: 'hello' },
			{ url: 'https://b.example/2', status: 404, body: 'no' }
		];
		const out = sb.transform(responses);
		expect(out).toEqual({
			ok: true,
			value: [
				{ sensor: 'status.200', value: 5 },
				{ sensor: 'status.404', value: 2 }
			]
		});
		sb.dispose();
	});

	it('rejects a script that never assigns the two required functions', async () => {
		const r = await createPackageSandbox(
			`module.exports = { requests: function () { return []; } };`
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toContain('module.exports = { requests, transform }');
	});

	it('rejects a script that throws at compile time (the compile eval reports the error)', async () => {
		const r = await createPackageSandbox(`throw new Error('compile go boom');`);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toContain('compile go boom');
	});

	it('surfaces a thrown Error from requests() as { ok:false, error } with the message', async () => {
		const r = await createPackageSandbox(`
			module.exports = {
				requests: function () { throw new Error('no network plan'); },
				transform: function () { return []; }
			};
		`);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const out = r.sandbox.requests();
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.error).toContain('no network plan');
		r.sandbox.dispose();
	});

	it('reports "error" for a thrown object without a message (the ?? fallback)', async () => {
		const r = await createPackageSandbox(`
			module.exports = {
				requests: function () { throw { code: 7 }; },
				transform: function () { return []; }
			};
		`);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		// dumped error is an object with no .message → `err.message ?? 'error'` → "error".
		expect(r.sandbox.requests()).toEqual({ ok: false, error: 'error' });
		r.sandbox.dispose();
	});

	it('stringifies a thrown primitive (non-object error) verbatim', async () => {
		const r = await createPackageSandbox(`
			module.exports = {
				requests: function () { throw 'plain string'; },
				transform: function () { return []; }
			};
		`);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		// a thrown string dumps to a primitive → the ternary's `: err` arm → String(err).
		expect(r.sandbox.requests()).toEqual({ ok: false, error: 'plain string' });
		r.sandbox.dispose();
	});

	it('reports "returned malformed JSON" when a hostile script poisons JSON.stringify', async () => {
		// The host wraps each call in `JSON.stringify(__src.xxx())`; a script that globally replaces
		// JSON.stringify with a non-JSON producer trips the inner JSON.parse guard.
		const r = await createPackageSandbox(`
			JSON.stringify = function () { return 'NOT JSON'; };
			module.exports = {
				requests: function () { return []; },
				transform: function () { return []; }
			};
		`);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.sandbox.requests()).toEqual({ ok: false, error: 'returned malformed JSON' });
		r.sandbox.dispose();
	});

	it('reports "returned no JSON-serializable value" when a call yields undefined', async () => {
		// transform returns undefined → JSON.stringify(undefined) is `undefined` (not a string).
		const r = await createPackageSandbox(`
			module.exports = {
				requests: function () { return []; },
				transform: function () { return undefined; }
			};
		`);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const out = r.sandbox.transform([]);
		expect(out).toEqual({ ok: false, error: 'returned no JSON-serializable value' });
		r.sandbox.dispose();
	});

	it('injects responses as inert DATA — a hostile body cannot escape into code', async () => {
		const r = await createPackageSandbox(`
			module.exports = {
				requests: function () { return []; },
				transform: function (responses) { return [{ sensor: 's', value: responses[0].body }]; }
			};
		`);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		// A body that looks like code stays a plain string.
		const out = r.sandbox.transform([
			{ url: 'https://x', status: 200, body: '"); globalThis.PWNED = 1; ("' }
		]);
		expect(out).toEqual({
			ok: true,
			value: [{ sensor: 's', value: '"); globalThis.PWNED = 1; ("' }]
		});
		r.sandbox.dispose();
	});

	it('kills a runaway transform() via the per-call deadline', async () => {
		const r = await createPackageSandbox(`
			module.exports = {
				requests: function () { return []; },
				transform: function () { while (true) {} }
			};
		`);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const out = r.sandbox.transform([]);
		expect(out.ok).toBe(false);
		r.sandbox.dispose();
	});

	it('is sandboxed — host globals (fetch / process) are not reachable', async () => {
		const r = await createPackageSandbox(`
			module.exports = {
				requests: function () { return [typeof fetch, typeof process]; },
				transform: function () { return []; }
			};
		`);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.sandbox.requests()).toEqual({ ok: true, value: ['undefined', 'undefined'] });
		r.sandbox.dispose();
	});

	it('returns "sandbox disposed" once dispose() has run, and dispose is idempotent', async () => {
		const r = await createPackageSandbox(GOOD_SCRIPT);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const sb = r.sandbox;
		sb.dispose();
		sb.dispose(); // second dispose is a no-op (must not throw / double-free)
		expect(sb.requests()).toEqual({ ok: false, error: 'sandbox disposed' });
		expect(sb.transform([])).toEqual({ ok: false, error: 'sandbox disposed' });
	});
});
