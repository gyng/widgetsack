import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	__disposeFormulaEngine,
	evalExpr,
	initFormulaEngine,
	isFormulaEngineReady,
	onFormulaEngineReady
} from './engine';
import { TEMPLATE_FUNCTIONS } from '../core/templateFns';

beforeAll(async () => {
	await initFormulaEngine();
});
afterAll(() => __disposeFormulaEngine());

describe('formula engine', () => {
	it('becomes ready after init', () => {
		expect(isFormulaEngineReady()).toBe(true);
	});

	it('evaluates arithmetic against namespaced sensor values', () => {
		expect(evalExpr('cpu.total / 2 + mem.used', { 'cpu.total': 50, 'mem.used': 10 })).toBe(35);
	});

	it('exposes math helpers (round / toDecimalPlace / clamp)', () => {
		expect(evalExpr('round(cpu.total, 2)', { 'cpu.total': 37.456 })).toBe(37.46);
		expect(evalExpr('toDecimalPlace(mem.used / 3, 1)', { 'mem.used': 100 })).toBe(33.3);
		expect(evalExpr('clamp(cpu.total, 0, 100)', { 'cpu.total': 150 })).toBe(100);
	});

	it('exposes format helpers reused from core/format (bytes / rate / percent)', () => {
		expect(evalExpr('bytes(mem.used)', { 'mem.used': 1024 })).toBe('1.0 KiB');
		expect(evalExpr('rate(net.down)', { 'net.down': 1024 })).toBe('1.0 KiB/s');
		expect(evalExpr('percent(cpu.total, 1)', { 'cpu.total': 37.45 })).toBe('37.5%');
	});

	// Drift guard for the generated templating docs: every helper documented in core/templateFns.ts
	// must actually be a callable function in the sandbox (catches a renamed/removed prelude/host fn).
	it('provides every documented TEMPLATE_FUNCTIONS helper', () => {
		for (const f of TEMPLATE_FUNCTIONS) {
			expect(evalExpr(`typeof ${f.name}`, {})).toBe('function');
		}
	});

	it('supports string-producing expressions and native JS', () => {
		expect(evalExpr(`cpu.total + '%'`, { 'cpu.total': 42 })).toBe('42%');
		expect(evalExpr('(mem.used).toFixed(2)', { 'mem.used': 3.14159 })).toBe('3.14');
	});

	it('returns null on a parse error, unknown reference, or non-finite result', () => {
		expect(evalExpr('cpu.total +', { 'cpu.total': 1 })).toBeNull(); // syntax error
		expect(evalExpr('does.not.exist', {})).toBeNull(); // ReferenceError-ish → TypeError
		expect(evalExpr('1 / 0', {})).toBeNull(); // Infinity → null
	});

	it('is sandboxed — host globals are not reachable', () => {
		expect(evalExpr('typeof process', {})).toBe('undefined');
		expect(evalExpr('typeof globalThis.fetch', {})).toBe('undefined');
	});

	it('kills a runaway expression via the per-eval deadline (no hang)', () => {
		expect(evalExpr('(function(){ while (true) {} })()', {})).toBeNull();
	});

	it('caps memory — a huge single allocation throws (caught → null) instead of ballooning', () => {
		expect(evalExpr(`'x'.repeat(1e8)`, {})).toBeNull(); // ~200 MiB string » 16 MiB cap
	});

	it('does not leak sensor values between evaluations', () => {
		expect(evalExpr('cpu.total', { 'cpu.total': 99 })).toBe(99);
		// A later eval that doesn't provide cpu must not see the previous 99.
		expect(evalExpr('typeof cpu', {})).toBe('undefined');
	});

	it('stringifies a boolean result', () => {
		expect(evalExpr('cpu.total > 50', { 'cpu.total': 75 })).toBe('true');
		expect(evalExpr('cpu.total > 50', { 'cpu.total': 10 })).toBe('false');
	});

	it('returns null for a non-number/string/boolean result (object / array / undefined)', () => {
		expect(evalExpr('({ a: 1 })', {})).toBeNull();
		expect(evalExpr('[1, 2, 3]', {})).toBeNull();
		expect(evalExpr('undefined', {})).toBeNull();
	});

	it('omits a null sensor value (treated as absent) so a bare ref yields null, not 0', () => {
		// cpu.total is null → omitted from scope → bare reference throws (caught) → null, NOT 0.
		expect(evalExpr('cpu.total', { 'cpu.total': null })).toBeNull();
		// a present sensor alongside a null one still resolves.
		expect(evalExpr('mem.used + 1', { 'mem.used': 4, 'cpu.total': null })).toBe(5);
	});
});

describe('onFormulaEngineReady', () => {
	it('returns an unsubscribe that removes the listener (no double-fire, no leak)', async () => {
		// The engine is already ready (beforeAll), so a fresh subscriber won't be called by a future
		// transition — but subscribe/unsubscribe must still add then drop the listener cleanly.
		let calls = 0;
		const off = onFormulaEngineReady(() => {
			calls += 1;
		});
		off(); // unsubscribe
		// Re-init is idempotent (cached promise) and does not re-run listeners.
		await initFormulaEngine();
		expect(calls).toBe(0);
	});

	it('fires registered ready listeners when init transitions from cold', async () => {
		__disposeFormulaEngine(); // clears the cached promise + listeners
		expect(isFormulaEngineReady()).toBe(false);
		let fired = false;
		const off = onFormulaEngineReady(() => {
			fired = true;
		});
		await initFormulaEngine();
		expect(fired).toBe(true);
		expect(isFormulaEngineReady()).toBe(true);
		off();
	});
});

describe('evalExpr before init', () => {
	it('returns null when the engine is not ready (no ctx/runtime), then restores', async () => {
		__disposeFormulaEngine();
		expect(isFormulaEngineReady()).toBe(false);
		expect(evalExpr('1 + 1', {})).toBeNull(); // the !ctx || !runtime guard
		await initFormulaEngine(); // restore so afterAll's dispose has something to tear down
		expect(isFormulaEngineReady()).toBe(true);
	});
});
