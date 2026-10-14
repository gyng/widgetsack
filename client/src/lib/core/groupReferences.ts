import { isContainer, isGroup, type LayoutNode, type Library } from './layoutTree';
import { applyParams } from './params';

/** Check the effective tree, including instance overrides, before recursive rendering.
 * References may repeat across siblings, but not along one active path. */
export function safeGroupReferences(
	tree: LayoutNode,
	library: Library | undefined,
	active: readonly string[] = [],
	depth = 0
): boolean {
	if (depth > 64) return false;
	if (isContainer(tree))
		return tree.children.every((child) => safeGroupReferences(child, library, active, depth + 1));
	if (!isGroup(tree.unit)) return true;
	const group = tree.unit;
	const def = group.def ? library?.defs.find((entry) => entry.id === group.def) : undefined;
	if (def && active.includes(def.id)) return false;
	let child = def?.child ?? group.child;
	if (def && group.params) {
		child = applyParams(JSON.parse(JSON.stringify(child)), def.params, group.params);
	}
	return safeGroupReferences(child, library, def ? [...active, def.id] : active, depth + 1);
}
