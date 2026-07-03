// The QuickJS sandbox for third-party package sensor sources (Phase 2). Each enabled package with
// a `source` gets its OWN runtime + context (isolated from the formula engine and from other
// packages) built from the shared WASM module (engine.ts loadQuickJSModule). The sandbox has ZERO
// capabilities — no host functions, no fetch, no Tauri, no DOM, no timers; the host performs the
// network I/O between the script's two PURE calls:
//
//   module.exports = {
//     requests(): string[]                                      // https URLs to fetch this tick
//     transform(responses: {url,status,body}[]): {sensor,value}[]  // samples to ingest
//   }
//
// Data crosses the boundary as JSON in both directions (same pattern as engine.ts evalExpr), and
// every call runs under an interrupt deadline + the runtime's memory/stack caps, so a hostile
// script can burn ~100ms of CPU per tick and nothing else.
import type { QuickJSContext, QuickJSRuntime } from 'quickjs-emscripten-core';
import { loadQuickJSModule } from './engine';

// Per-call CPU budget. Wider than the formula engine's 50ms (a transform may JSON.parse a
// few-hundred-KiB body) but still interactive-frame-class.
const CALL_DEADLINE_MS = 100;
const MEMORY_LIMIT = 16 * 1024 * 1024;
const STACK_LIMIT = 512 * 1024;

/** One response as the sandbox's `transform` sees it. Failed fetches arrive as status 0. */
export type SandboxResponse = { url: string; status: number; body: string };

export type SandboxResult = { ok: true; value: unknown } | { ok: false; error: string };

export type PackageSandbox = {
	/** Call the script's `requests()`; the value is the JSON round-trip of its return. */
	requests(): SandboxResult;
	/** Call the script's `transform(responses)`. */
	transform(responses: SandboxResponse[]): SandboxResult;
	dispose(): void;
};

export type CreateSandboxResult =
	{ ok: true; sandbox: PackageSandbox } | { ok: false; error: string };

/**
 * Compile `script` (a CommonJS-style source.js that assigns `module.exports`) into a fresh,
 * isolated sandbox. Fail-soft: any load/compile/shape problem returns `{ ok: false, error }` and
 * leaks nothing. The caller owns `dispose()`.
 */
export async function createPackageSandbox(script: string): Promise<CreateSandboxResult> {
	let runtime: QuickJSRuntime;
	try {
		const mod = await loadQuickJSModule();
		runtime = mod.newRuntime();
	} catch (err) {
		return { ok: false, error: `sandbox init failed: ${String(err)}` };
	}
	runtime.setMemoryLimit(MEMORY_LIMIT);
	runtime.setMaxStackSize(STACK_LIMIT);
	const ctx: QuickJSContext = runtime.newContext();

	// Evaluate `code` (which must produce a JSON string) under the deadline; never throws.
	const evalJson = (code: string): SandboxResult => {
		const deadline = Date.now() + CALL_DEADLINE_MS;
		runtime.setInterruptHandler(() => Date.now() > deadline);
		try {
			const out = ctx.evalCode(code);
			if (out.error) {
				const err = ctx.dump(out.error) as { message?: string } | string | null;
				out.error.dispose();
				const msg = typeof err === 'object' && err !== null ? (err.message ?? 'error') : err;
				return { ok: false, error: String(msg) };
			}
			const v = ctx.dump(out.value);
			out.value.dispose();
			if (typeof v !== 'string') return { ok: false, error: 'returned no JSON-serializable value' };
			try {
				return { ok: true, value: JSON.parse(v) as unknown };
			} catch {
				return { ok: false, error: 'returned malformed JSON' };
			}
		} catch (err) {
			return { ok: false, error: String(err) };
		} finally {
			runtime.setInterruptHandler(() => false);
		}
	};

	// Compile once: run the script in a CommonJS-shaped wrapper, stash module.exports on the
	// context's global, and verify it exposes the two functions. The script never re-evaluates —
	// later ticks only call __src.requests/__src.transform.
	const compiled = evalJson(
		`JSON.stringify((function () {
			var module = { exports: {} }; var exports = module.exports;
			${script}
			;globalThis.__src = module.exports;
			return typeof __src.requests === 'function' && typeof __src.transform === 'function';
		})())`
	);
	if (!compiled.ok || compiled.value !== true) {
		ctx.dispose();
		runtime.dispose();
		return {
			ok: false,
			error: compiled.ok
				? 'source.js must assign module.exports = { requests, transform } (both functions)'
				: compiled.error
		};
	}

	let disposed = false;
	return {
		ok: true,
		sandbox: {
			requests: () =>
				disposed
					? { ok: false, error: 'sandbox disposed' }
					: evalJson('JSON.stringify(__src.requests())'),
			transform: (responses) =>
				disposed
					? { ok: false, error: 'sandbox disposed' }
					: // Responses are injected as DATA: JSON.stringify output is a valid JS literal, so
						// a hostile body can't escape into code.
						evalJson(`JSON.stringify(__src.transform(${JSON.stringify(responses)}))`),
			dispose: () => {
				if (disposed) return;
				disposed = true;
				ctx.dispose();
				runtime.dispose();
			}
		}
	};
}
