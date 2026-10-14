// Presets (saved layout slots, extracted from Canvas): name the current monitor's arrangement,
// load one back (one undoable commit), delete a slot. Pure pack/unpack lives in core/savedLayout;
// this hook owns the layouts/ file I/O + the outcome line the Presets panel shows. The preset name
// arrives from the panel's inline field (no prompt()); only the destructive/overwriting steps keep
// a confirm(). Reads the live monitor via the Canvas's monitorRef so a save mid-render captures the
// committed tree, not a stale closure.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MonitorLayout } from '../../core/layoutTree';
import { packLayout, unpackLayout } from '../../core/savedLayout';
import { deleteLayout, listLayouts, readLayout, saveLayoutAs } from '../../overlay';
import type { SectionId } from './studioSections';
import type { EditorModel } from './useEditorModel';

type Deps = {
	studio: boolean;
	navSection: SectionId;
	editingDefId: string | null;
	monitorRef: React.RefObject<MonitorLayout>;
	commitOp: EditorModel['commitOp'];
};

/** The last preset action's outcome, rendered inline by the Presets panel. */
export type PresetStatus = { kind: 'ok' | 'error'; message: string } | null;

export type SavedLayouts = {
	/** The saved presets (names), loaded when the Presets section is open. */
	layoutNames: string[];
	/** The last save/load/delete outcome ("Saved preset X · N presets", or why it failed). */
	status: PresetStatus;
	/** Save this monitor's arrangement under `name` (from the panel's inline field). */
	saveCurrentLayout: (name: string) => Promise<void>;
	loadSavedLayout: (name: string) => Promise<void>;
	deleteSavedLayout: (name: string) => Promise<void>;
};

const FINISH_EDITING = 'Finish editing the current custom widget (Done) before ';

export function useSavedLayouts({
	studio,
	navSection,
	editingDefId,
	monitorRef,
	commitOp
}: Deps): SavedLayouts {
	const [layoutNames, setLayoutNames] = useState<string[]>([]);
	const [status, setStatus] = useState<PresetStatus>(null);
	const loadRevision = useRef(0);
	useEffect(
		() => () => {
			loadRevision.current++;
		},
		[editingDefId]
	);

	// Load the preset names when the Presets section opens.
	useEffect(() => {
		if (studio && navSection === 'saved-layouts') listLayouts().then(setLayoutNames);
	}, [studio, navSection]);

	const saveCurrentLayout = useCallback(
		async (rawName: string) => {
			if (editingDefId != null) {
				// Mid def-edit `monitor` is the def scratch, not the real layout — finish first (like sacks).
				setStatus({ kind: 'error', message: `${FINISH_EDITING}saving a preset.` });
				return;
			}
			const name = rawName.trim();
			if (!name) {
				setStatus({ kind: 'error', message: 'Enter a name for the preset.' });
				return;
			}
			const json = JSON.stringify(packLayout(monitorRef.current, name), null, '\t');
			let existing: string[];
			try {
				existing = await listLayouts(true);
			} catch (error) {
				setStatus({ kind: 'error', message: `Could not check existing presets: ${String(error)}` });
				return;
			}
			const exists = existing.some((saved) => saved.toLowerCase() === name.toLowerCase());
			if (exists && !window.confirm(`Overwrite the preset “${name}”?`)) return;
			const path = await saveLayoutAs(name, json, exists);
			const names = await listLayouts();
			setLayoutNames(names);
			if (!path) {
				setStatus({
					kind: 'error',
					message:
						'Could not save the preset. Check the name and folder permissions, then try again.'
				});
				return;
			}
			setStatus({
				kind: 'ok',
				message: `Saved preset ${name} · ${names.length} preset${names.length === 1 ? '' : 's'}`
			});
		},
		[editingDefId, monitorRef]
	);

	const loadSavedLayout = useCallback(
		async (name: string) => {
			if (editingDefId != null) {
				setStatus({ kind: 'error', message: `${FINISH_EDITING}loading a preset.` });
				return;
			}
			const revision = ++loadRevision.current;
			const target = monitorRef.current;
			const raw = await readLayout(name);
			if (revision !== loadRevision.current) return;
			if (target !== monitorRef.current) {
				setStatus({
					kind: 'error',
					message:
						'The layout changed while the preset was loading. Load it again to replace the current layout.'
				});
				return;
			}
			const mon = raw ? unpackLayout(raw) : null;
			if (!mon) {
				setStatus({ kind: 'error', message: `Could not read the preset “${name}”.` });
				return;
			}
			if (
				!window.confirm(
					`Replace this monitor’s layout with the preset “${name}”? (Ctrl+Z restores it.)`
				)
			) {
				return;
			}
			// One undoable commit replaces the current monitor; the persistence hook then writes it to
			// widgets.json for this monitor. Selection is cleared (the old ids are gone).
			commitOp(() => ({ monitor: mon, selectedId: null, selectedIds: [] }));
			setStatus({
				kind: 'ok',
				message: `Loaded preset ${name} — Ctrl+Z restores the previous layout.`
			});
		},
		[editingDefId, monitorRef, commitOp]
	);

	const deleteSavedLayout = useCallback(async (name: string) => {
		if (!window.confirm(`Delete the preset “${name}”?`)) return;
		if (!(await deleteLayout(name))) {
			setStatus({ kind: 'error', message: `Could not delete the preset “${name}”.` });
			return;
		}
		const names = await listLayouts();
		setLayoutNames(names);
		setStatus({
			kind: 'ok',
			message: `Deleted preset ${name} · ${names.length} preset${names.length === 1 ? '' : 's'}`
		});
	}, []);

	return { layoutNames, status, saveCurrentLayout, loadSavedLayout, deleteSavedLayout };
}
