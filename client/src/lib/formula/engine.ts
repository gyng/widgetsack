// Sandboxed expression evaluator for widget formulas (outer-ring adapter — stateful + async, so NOT
// in lib/core). Expressions are real JavaScript run inside a QuickJS-in-WASM interpreter that has NO
// host bindings (no Tauri, no fetch, no DOM) and a per-eval CPU deadline. This is deliberately a true
// sandbox rather than `new Function`: widget layouts (and thus formulas) are shared via sacks
// (core/sack.ts), so an imported formula must not be able to do more than burn a few ms of CPU.
//
// CSP note: instantiating WebAssembly requires `'wasm-unsafe-eval'` in script-src (tauri.conf.json).
import {
	newQuickJSWASMModuleFromVariant,
	type QuickJSContext,
	type QuickJSRuntime,
	type QuickJSWASMModule
} from 'quickjs-emscripten-core';
// One pinned variant with the WASM embedded (base64) in the JS — a single payload, no runtime .wasm
// fetch (robust under Tauri's CSP/asset protocol) instead of the umbrella package's 4 wasm flavors.
import quickjsVariant from '@jitl/quickjs-singlefile-browser-release-sync';
import { formatBytes, formatPercent, formatRate } from '../core/format';
import { buildScope } from '../core/textTemplate';

// Each eval is bounded so a pathological formula (e.g. `while(true){}` in an imported sack) can't hang
// the UI thread — the interrupt handler trips once this many ms elapse and the eval throws.
const EVAL_DEADLINE_MS = 50;

// Pure helpers defined inside the sandbox (no host-call overhead). Formatting helpers that already
// exist in core/format.ts are injected as host functions instead (defineHostFns) to avoid duplicating
// their logic. Native `Math`, `.toFixed()`, ternaries, etc. are available for free.
const PRELUDE = `
globalThis.round = function (x, d) { var m = Math.pow(10, d || 0); return Math.round(Number(x) * m) / m; };
globalThis.toDecimalPlace = globalThis.round;
globalThis.clamp = function (x, lo, hi) { return Math.min(hi, Math.max(lo, Number(x))); };
`;

let runtime: QuickJSRuntime | null = null;
let ctx: QuickJSContext | null = null;
let readyPromise: Promise<void> | null = null;
const readyListeners = new Set<() => void>();

// The WASM module itself is loaded once per window and shared: the formula engine's singleton
// context AND every package-source sandbox (packageSandbox.ts) get their own runtime from it.
let modulePromise: Promise<QuickJSWASMModule> | null = null;

/** The (cached) QuickJS-WASM module load. Rejects on a genuine load failure — callers decide
 *  whether that's fatal (a package source reports an error status; the formula engine just stays
 *  not-ready). */
export function loadQuickJSModule(): Promise<QuickJSWASMModule> {
	if (!modulePromise) modulePromise = newQuickJSWASMModuleFromVariant(quickjsVariant);
	return modulePromise;
}

function defineHostFns(c: QuickJSContext): void {
	const reg = (name: string, fn: (...args: number[]) => string) => {
		const handle = c.newFunction(name, (...args) =>
			c.newString(fn(...args.map((a) => Number(c.dump(a)))))
		);
		c.setProp(c.global, name, handle);
		handle.dispose();
	};
	const dp = (d: number | undefined, fallback: number) =>
		d === undefined || Number.isNaN(d) ? fallback : d;
	reg('bytes', (x, d) => formatBytes(x, dp(d, 1)));
	reg('rate', (x, d) => formatRate(x, dp(d, 1)));
	reg('percent', (x, d) => formatPercent(x, dp(d, 0)));
}

/** Kick off the (async) WASM init. Idempotent — safe to call from every formula widget; the promise is
 *  cached. Resolves once the sandbox is ready; never rejects (a failed init just leaves it not-ready). */
export function initFormulaEngine(): Promise<void> {
	if (!readyPromise) {
		readyPromise = loadQuickJSModule()
			.then((QuickJS) => {
				runtime = QuickJS.newRuntime();
				// Bound an adversarial / imported-sack formula's RESOURCES as tightly as its CPU: the
				// per-eval interrupt deadline stops a runaway loop, but a single bulk allocation
				// (`'x'.repeat(1e9)`) is one uninterruptible VM call — cap heap + stack so it throws
				// (→ caught → null) instead of ballooning this long-lived singleton's memory. Generous
				// vs our tiny scalar scopes (16 MiB / 512 KiB), tiny vs the 2 GiB WASM ceiling.
				runtime.setMemoryLimit(16 * 1024 * 1024);
				runtime.setMaxStackSize(512 * 1024);
				ctx = runtime.newContext();
				defineHostFns(ctx);
				ctx.unwrapResult(ctx.evalCode(PRELUDE)).dispose();
				readyListeners.forEach((cb) => cb());
			})
			.catch((err) => {
				console.error('[formula] engine init failed', err);
			});
	}
	return readyPromise;
}

export function isFormulaEngineReady(): boolean {
	return ctx !== null;
}

/** Subscribe to the one-shot ready transition (for useSyncExternalStore). Fires when init completes. */
export function onFormulaEngineReady(cb: () => void): () => void {
	readyListeners.add(cb);
	return () => {
		readyListeners.delete(cb);
	};
}

/** Evaluate a single expression against namespaced sensor values, in the sandbox. Returns a finite
 *  number or a string on success, or `null` on any parse/eval error, non-finite result, or timeout —
 *  callers render `null` as `–` rather than crashing. Sensor values are injected as DATA (JSON) and
 *  read via `with`, so they can't be reinterpreted as code and don't leak between evaluations. */
export function evalExpr(
	src: string,
	values: Record<string, number | string | null>
): number | string | null {
	if (!ctx || !runtime) return null;
	// A null value means the sensor hasn't emitted yet — treat it as ABSENT (omit it) rather than
	// injecting null, which JS would coerce to 0 in arithmetic (a fresh gauge would flash 0). Omitted →
	// the reference is `undefined` → arithmetic yields NaN and a bare ref throws → we return null → `–`.
	const present: Record<string, number | string> = {};
	for (const [k, v] of Object.entries(values)) if (v !== null) present[k] = v;
	const scopeJson = JSON.stringify(buildScope(present));
	const deadline = Date.now() + EVAL_DEADLINE_MS;
	runtime.setInterruptHandler(() => Date.now() > deadline);
	try {
		const out = ctx.evalCode(
			`(function (__scope) { with (__scope) { return (${src}); } })(${scopeJson})`
		);
		if (out.error) {
			out.error.dispose();
			return null;
		}
		const v = ctx.dump(out.value);
		out.value.dispose();
		if (typeof v === 'number') return Number.isFinite(v) ? v : null;
		if (typeof v === 'string') return v;
		if (typeof v === 'boolean') return String(v);
		return null;
	} catch {
		/* v8 ignore next -- native QuickJS reports expression faults through out.error; this is host hardening. */
		return null;
	} finally {
		/* v8 ignore next -- reset handlers are installed for later evaluations, not invoked by this call. */
		runtime.setInterruptHandler(() => false);
	}
}

// Test-only: tear the singleton down so suites don't leak the WASM runtime across files.
export function __disposeFormulaEngine(): void {
	ctx?.dispose();
	runtime?.dispose();
	ctx = null;
	runtime = null;
	readyPromise = null;
	readyListeners.clear();
}
