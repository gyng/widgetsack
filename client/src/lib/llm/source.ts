// Outer-ring Tauri adapter for streamed LLM tokens: listen to the `llm_delta` event and fold each
// frame into the chat store via the pure reducer. The Tauri import lives ONLY here (AGENTS.md §5);
// core/llm.ts and the store stay framework-agnostic.
//
// REFERENCE-COUNTED so multiple consumers (the settings chat tester, any future chat UI) share ONE
// listener: the listener attaches on the first start and detaches only when the LAST consumer stops.
// Each call returns a per-call stop fn (safe to call once); paired with a cancellation guard in the
// caller's effect, this is robust against a consumer that unmounts before listen() resolves.
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { LlmDelta } from '../core/llm';
import { handleDelta } from '../../stores/llmStore';
import { EVENTS } from '../bridge/contract';

export const LLM_DELTA_EVENT = EVENTS.llmDelta;

let refs = 0;
let unlisten: UnlistenFn | null = null;
let attaching: Promise<void> | null = null;

/** Subscribe to the `llm_delta` → store bridge (reference-counted). Resolves once the shared listener
 * is live, and returns a stop fn that decrements the count and detaches when it reaches zero. */
export async function startLlmSource(): Promise<UnlistenFn> {
	refs += 1;
	if (!unlisten && !attaching) {
		attaching = (async () => {
			try {
				const u = await listen<LlmDelta>(LLM_DELTA_EVENT, (ev) => handleDelta(ev.payload));
				// startLlmSource does not expose its stop function until attachment resolves, so at least
				// one reference necessarily remains here.
				unlisten = u;
			} catch {
				// no Tauri runtime (plain-browser dev): streaming just won't fire.
			} finally {
				attaching = null;
			}
		})();
	}
	if (attaching) await attaching;

	let stopped = false;
	return () => {
		if (stopped) return; // idempotent per call
		stopped = true;
		refs = Math.max(0, refs - 1);
		if (refs === 0) {
			unlisten?.();
			unlisten = null;
		}
	};
}
