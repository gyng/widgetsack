import { isContainer, isGroup, type LayoutNode, type Library, type WidgetDef } from './layoutTree';
import { applyParams } from './params';

const MAX_DEPTH = 64;
// Instances with params are re-expanded every time, so a crafted library can still fan out.
const MAX_VISITS = 50_000;

/** Check the effective tree, including instance overrides, before recursive rendering.
 * References may repeat across siblings, but not along one active path. */
export function safeGroupReferences(
	tree: LayoutNode,
	library: Library | undefined,
	active: readonly string[] = []
): boolean {
	// Height below a param-free reference to a definition; params can retarget nested references.
	const heights = new Map<string, number>();
	let visits = 0;
	const walk = (node: LayoutNode, path: readonly string[], depth: number): number => {
		if (depth > MAX_DEPTH || ++visits > MAX_VISITS) return -1;
		if (isContainer(node)) {
			let height = 0;
			for (const child of node.children) {
				const below = walk(child, path, depth + 1);
				if (below < 0) return -1;
				height = Math.max(height, below + 1);
			}
			return height;
		}
		if (!isGroup(node.unit)) return 0;
		const group = node.unit;
		const def = group.def ? library?.defs.find((entry) => entry.id === group.def) : undefined;
		if (def && path.includes(def.id)) return -1;
		const known = def && !group.params ? heights.get(def.id) : undefined;
		if (known !== undefined) return depth + 1 + known > MAX_DEPTH ? -1 : known + 1;
		let child = def?.child ?? group.child;
		if (def && group.params) {
			child = applyParams(JSON.parse(JSON.stringify(child)), def.params, group.params);
		}
		const below = walk(child, def ? [...path, def.id] : path, depth + 1);
		if (below < 0) return -1;
		if (def && !group.params) heights.set(def.id, below);
		return below + 1;
	};
	return walk(tree, active, 0) >= 0;
}

/** Whether `from` (or anything it references) refers to `target`, so inserting `from` into
 * `target` would make a definition contain itself. Static references only. */
export function definitionReaches(library: Library | undefined, from: string, target: string) {
	const seen = new Set<string>();
	const pending = [from];
	while (pending.length) {
		const id = pending.pop()!;
		if (id === target) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		const def = library?.defs.find((entry) => entry.id === id);
		if (def) collectReferences(def.child, pending);
	}
	return false;
}

function collectReferences(node: LayoutNode, into: string[]) {
	if (isContainer(node)) {
		for (const child of node.children) collectReferences(child, into);
	} else if (isGroup(node.unit)) {
		if (node.unit.def) into.push(node.unit.def);
		collectReferences(node.unit.child, into);
	}
}

/** Remove definitions that cannot render safely (cycles, excessive depth) instead of rejecting the
 * whole document. Only `candidates` may be removed; a dropped reference falls back to its inline
 * child, so removal never makes another definition unsafe. */
export function withoutUnsafeDefinitions(
	library: Library,
	candidates: ReadonlySet<string> = new Set(library.defs.map((def) => def.id))
): { library: Library; dropped: string[] } {
	const unsafe = (defs: WidgetDef[]) =>
		defs.filter(
			(def) =>
				candidates.has(def.id) && !safeGroupReferences(def.child, { ...library, defs }, [def.id])
		);
	let defs = library.defs;
	const dropped: string[] = [];
	for (let bad = unsafe(defs); bad.length; bad = unsafe(defs)) {
		dropped.push(...bad.map((def) => def.id));
		defs = defs.filter((def) => !bad.includes(def));
	}
	return { library: dropped.length ? { ...library, defs } : library, dropped };
}
