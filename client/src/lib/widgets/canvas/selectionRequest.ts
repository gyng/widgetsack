export type SelectionRequest = { id: string; additive?: boolean };
export function selectionRequest(
	id: string,
	modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }
): SelectionRequest {
	return modifiers.ctrlKey || modifiers.metaKey || modifiers.shiftKey
		? { id, additive: true }
		: { id };
}
