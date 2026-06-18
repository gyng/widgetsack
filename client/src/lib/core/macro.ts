// A macro is an ordered list of actions bound to a control press (a chained sequence run in
// order on press). Each action is a single {domain, service, data?}
// call — structurally the widgets-layer ControlEvent — run in sequence when the button is clicked.
// This is the pure DOMAIN: the schema, the sequential runner, and the immutable edit ops all live
// here so they're testable without Tauri/React. The side-effecting dispatch (the actual `invoke`)
// lives in Canvas.onWidgetControl (AGENTS.md §5/§6).

export type MacroAction = {
	domain: string;
	service: string;
	data?: Record<string, unknown>;
};

export type Macro = MacroAction[];

// One step's outcome, so a caller can log/surface failures without the runner ever throwing.
export type MacroStepResult = { action: MacroAction; ok: boolean; error?: unknown };

// Coerce arbitrary config JSON into a clean MacroAction[]: drop entries that aren't an object with a
// string `domain` + `service`, and strip a non-plain-object `data`. The button's `actions` config is
// hand-editable JSON, so this is the boundary that keeps a malformed entry from reaching dispatch.
export function normalizeMacro(value: unknown): Macro {
	if (!Array.isArray(value)) return [];
	const out: Macro = [];
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') continue;
		const r = raw as Record<string, unknown>;
		if (typeof r.domain !== 'string' || typeof r.service !== 'string') continue;
		const action: MacroAction = { domain: r.domain, service: r.service };
		if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
			action.data = r.data as Record<string, unknown>;
		}
		out.push(action);
	}
	return out;
}

// Run a macro: dispatch each action IN ORDER, awaiting each before the next (bangs fire
// sequentially). Continue-on-error — one offline light shouldn't abort the rest — collecting each
// step's outcome so the caller can log failures. Never throws; assumes `actions` is already
// normalized (call normalizeMacro at the config boundary).
export async function runMacro(
	actions: Macro,
	dispatch: (action: MacroAction) => Promise<void> | void
): Promise<MacroStepResult[]> {
	const results: MacroStepResult[] = [];
	for (const action of actions) {
		try {
			await dispatch(action);
			results.push({ action, ok: true });
		} catch (error) {
			results.push({ action, ok: false, error });
		}
	}
	return results;
}

// --- immutable edit ops for the Inspector's macro editor (pure; keep the editor component dumb) ---

/** Append a new (blank by default) action. */
export function addAction(
	actions: Macro,
	action: MacroAction = { domain: '', service: '' }
): Macro {
	return [...actions, action];
}

/** Remove the action at `index` (no-op for an out-of-range index). */
export function removeAction(actions: Macro, index: number): Macro {
	return actions.filter((_, i) => i !== index);
}

/** Patch the action at `index` (no-op for an out-of-range index). */
export function updateAction(actions: Macro, index: number, patch: Partial<MacroAction>): Macro {
	return actions.map((a, i) => (i === index ? { ...a, ...patch } : a));
}

/** Set (or, when `id` is blank, clear) the `entity_id` in an action's `data` — for the editor's
 * entity picker — without disturbing other data keys. Returns `undefined` when clearing leaves no
 * keys, matching the model's optional `data`. Pure. */
export function withEntityId(
	data: Record<string, unknown> | undefined,
	id: string
): Record<string, unknown> | undefined {
	const rest = { ...(data ?? {}) };
	if (id.trim() === '') {
		delete rest.entity_id;
		return Object.keys(rest).length ? rest : undefined;
	}
	return { ...rest, entity_id: id };
}

/** Move the action at `index` by `delta` slots; returns the list unchanged if the move is a no-op. */
export function moveAction(actions: Macro, index: number, delta: number): Macro {
	const to = index + delta;
	if (index < 0 || index >= actions.length || to < 0 || to >= actions.length) return actions;
	const next = [...actions];
	const [item] = next.splice(index, 1);
	next.splice(to, 0, item);
	return next;
}
