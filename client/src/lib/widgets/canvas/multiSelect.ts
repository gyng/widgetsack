// Pure helpers for the multi-select details pane (Figma-style common-properties editor). Given the
// widgets in a selection, compute the config fields they ALL share (so an edit can apply to every
// one) and whether their main-axis sizing agrees. ZERO React/DOM — co-located tests in
// multiSelect.test.ts; the MultiInspector renders the result and the Canvas applies the bulk edits.

import type { WidgetInstance } from '../../core/layout';
import type { Length } from '../../core/layoutTree';
import { fieldVisible, getMeta, type ConfigField } from '../../core/widget';

const eq = (a: unknown, b: unknown): boolean =>
	JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A config field shared by every selected widget, with the common value (or `mixed` when they
 * differ — the input then shows a "mixed" placeholder and only writes on an explicit edit). */
export type MergedField = { field: ConfigField; value: unknown; mixed: boolean };

/**
 * The config fields common to ALL `widgets` — a field is included only if every widget's TYPE meta
 * declares it with the same key + kind (so e.g. a gauge + clock still share `color`/`label`) AND it
 * is visible for every widget's own config (`showWhen`, as the single Inspector applies it — a
 * "volume device" hidden on one monitor switch must not surface via the multi-select). The value
 * is the shared one, or `mixed: true` when the widgets disagree. Empty for an empty selection.
 */
export function commonConfigFields(widgets: WidgetInstance[]): MergedField[] {
	if (widgets.length === 0) return [];
	const fieldLists = widgets.map((w) =>
		(getMeta(w.type)?.configFields ?? []).filter((f) => fieldVisible(f, w.config ?? {}))
	);
	const out: MergedField[] = [];
	for (const field of fieldLists[0]) {
		const inAll = fieldLists.every((fs) =>
			fs.some((f) => f.key === field.key && f.kind === field.kind)
		);
		if (!inAll) continue;
		const values = widgets.map((w) => w.config?.[field.key]);
		const mixed = values.some((v) => !eq(v, values[0]));
		out.push({ field, value: mixed ? undefined : values[0], mixed });
	}
	return out;
}

export type BasisMode = 'fixed' | 'content' | 'grow';
export type BasisSummary = BasisMode | 'mixed';

const basisModeOf = (b: Length | undefined): BasisMode =>
	typeof b === 'object' && b !== null && 'fr' in b ? 'grow' : b === 'content' ? 'content' : 'fixed';

/** The shared sizing mode across the selected leaves' bases, or 'mixed' when they disagree. */
export function commonBasisMode(bases: (Length | undefined)[]): BasisSummary {
	if (bases.length === 0) return 'fixed';
	const modes = bases.map(basisModeOf);
	return modes.every((m) => m === modes[0]) ? modes[0] : 'mixed';
}
