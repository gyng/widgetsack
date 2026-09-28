// The AI Provider plugin's slot for the StudioApi that Canvas hands every plugin's `studio`
// capability on studio mount (the generalized successor of the old layoutAssistantBridge). The
// plugin's `studio(api)` hook stashes the api here; the (props-less) LlmSettings layout assistant
// reads it through the free functions below. When no studio is mounted (overlay role / dev), the
// calls degrade gracefully. Plugin-internal — nothing outside the AI Provider plugin imports this.

import type { AssistantOp } from '../../core/llm';
import type { StudioApi, StudioApplyResult } from '../plugin';

let api: StudioApi | null = null;

export function setLlmStudioApi(next: StudioApi | null): void {
	api = next;
}

export function llmStudioReady(): boolean {
	return api !== null;
}

/** Capture the immutable layout and editor instance used to generate a proposal. */
export function captureLlmStudioTarget() {
	const owner = api;
	if (!owner) return null;
	const monitor = owner.monitor();
	if (!monitor) return null;
	return {
		monitor,
		apply(ops: AssistantOp[]): StudioApplyResult {
			if (api !== owner || owner.monitor() !== monitor)
				return {
					applied: 0,
					addedIds: [],
					errors: ['The layout changed while generating. Generate again for the current layout.']
				};
			return owner.apply(ops);
		}
	};
}
