import { isGroup, isLeaf, type WidgetDef } from '../../core/layoutTree';
import { updateNode } from '../../core/layoutEdit';
import { lookup, clone, type Patch } from './editorOps';
import type { EditorState } from './types';

/** Retarget exactly one placement; shared defaults and other placements remain unchanged. */
export function makeIndependentCopy(state: EditorState, id: string, newId: string): Patch {
	const node = lookup(id, state.monitor);
	if (!node || !isLeaf(node) || !isGroup(node.unit) || !node.unit.def) return {};
	const sourceId = node.unit.def;
	const source = state.library?.defs.find((def) => def.id === sourceId);
	if (!source) return {};
	const copy: WidgetDef = { ...clone(source), id: newId, name: `${source.name} copy` };
	const replacement = {
		...node,
		unit: { ...clone(node.unit), def: newId, name: copy.name, child: clone(copy.child) }
	};
	return {
		library: { ...state.library!, defs: [...state.library!.defs, copy] },
		monitor: {
			...state.monitor,
			root: updateNode(state.monitor.root, id, () => replacement),
			floating: state.monitor.floating.map((leaf) => (leaf.id === id ? replacement : leaf))
		},
		selectedId: id
	};
}
