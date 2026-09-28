import type { Library, MonitorLayout, WidgetDef } from './layoutTree';

/** The canvas is the active editing surface. Non-layout modes retain the desktop separately. */
export type EditorMode =
	| { kind: 'layout' }
	| { kind: 'definition'; defId: string; desktop: MonitorLayout; baseline: MonitorLayout }
	| { kind: 'preview'; definition: WidgetDef; desktop: MonitorLayout };

export function editingDefinitionId(mode: EditorMode): string | null {
	return mode.kind === 'layout'
		? null
		: mode.kind === 'definition'
			? mode.defId
			: mode.definition.id;
}
export function previewDefinition(mode: EditorMode): WidgetDef | null {
	return mode.kind === 'preview' ? mode.definition : null;
}
export function definitionBaseline(mode: EditorMode): MonitorLayout | null {
	return mode.kind === 'definition' ? mode.baseline : null;
}
export function desktopMonitor(state: { mode: EditorMode; monitor: MonitorLayout }): MonitorLayout {
	return state.mode.kind === 'layout' ? state.monitor : state.mode.desktop;
}

/** Fold only an editable definition into the library, preserving references when already current. */
export function editedLibrary(state: {
	mode: EditorMode;
	monitor: MonitorLayout;
	library: Library | undefined;
}): Library | undefined {
	const { mode, monitor, library } = state;
	if (mode.kind !== 'definition' || !library) return library;
	const def = library.defs.find((d) => d.id === mode.defId);
	if (!def || def.child === monitor.root) return library;
	return {
		...library,
		defs: library.defs.map((d) => (d === def ? { ...d, child: monitor.root } : d))
	};
}
