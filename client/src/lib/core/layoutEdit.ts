// Pure, immutable tree mutations for the layout/widget designers: find / insert /
// remove / move / update nodes in a v2 `Container` tree, plus flow-leaf collection for
// rendering. Every function returns a NEW tree (the input is never mutated), so Svelte
// reactivity and undo/redo stay simple. ZERO Svelte/Tauri; the shared editing core for
// Phase 5c (container ops), 5e (drag reorder/reparent), and 6a (group/ungroup).
// Co-located vitest tests in layoutEdit.test.ts.

import {
	type Container,
	type LayoutNode,
	type Leaf,
	type Library,
	type Rect,
	isContainer,
	isGroup,
	isLeaf
} from './layoutTree';
import { gridCellRects } from './solve';

function clone<T>(node: T): T {
	return JSON.parse(JSON.stringify(node)) as T;
}

/** Find a node (container or leaf) by id anywhere in the tree, including `node` itself. */
export function findNode(node: LayoutNode, id: string): LayoutNode | null {
	if (node.id === id) return node;
	if (isContainer(node)) {
		for (const child of node.children) {
			const hit = findNode(child, id);
			if (hit) return hit;
		}
	}
	return null;
}

/** The parent container of `id`, or null when `id` is the root or absent. */
export function findParent(root: Container, id: string): Container | null {
	for (const child of root.children) {
		if (child.id === id) return root;
		if (isContainer(child)) {
			const hit = findParent(child, id);
			if (hit) return hit;
		}
	}
	return null;
}

/**
 * Rebuild the tree, replacing the node whose id matches via `fn` (applied before
 * recursing into the result's children). Returns a new root; a no-op clone if `id` is
 * absent. `fn` is expected to preserve node kind.
 */
export function updateNode(
	root: Container,
	id: string,
	fn: (node: LayoutNode) => LayoutNode
): Container {
	return rebuild(root, id, fn) as Container;
}

function rebuild(node: LayoutNode, id: string, fn: (n: LayoutNode) => LayoutNode): LayoutNode {
	// Matched node: apply fn and STOP — do NOT re-descend into the result. Re-descending re-ran fn
	// whenever the replacement re-contained a node with the same id (e.g. wrapLeafWith nests the
	// target inside a fresh cell), which recursed unboundedly on the merge-drop path. Ids are unique,
	// so there is never a second node with this id to find below the match.
	if (node.id === id) return fn(node);
	if (isContainer(node)) {
		return { ...node, children: node.children.map((c) => rebuild(c, id, fn)) };
	}
	return node;
}

/** Shallow-patch the container with `id` (kind/gap/pad/align/justify/cols/basis/…). */
export function updateContainer(
	root: Container,
	id: string,
	patch: Partial<Omit<Container, 'id' | 'children'>>
): Container {
	return updateNode(root, id, (n) => (isContainer(n) ? { ...n, ...patch } : n));
}

function spliceInsert(children: LayoutNode[], node: LayoutNode, index?: number): LayoutNode[] {
	const at = index === undefined ? children.length : Math.max(0, Math.min(index, children.length));
	return [...children.slice(0, at), node, ...children.slice(at)];
}

/** Insert `node` as a child of container `parentId` at `index` (default: append). */
export function insertChild(
	root: Container,
	parentId: string,
	node: LayoutNode,
	index?: number
): Container {
	return updateNode(root, parentId, (n) =>
		isContainer(n) ? { ...n, children: spliceInsert(n.children, node, index) } : n
	);
}

/** Remove the node `id` and its subtree. Returns a new root; the root itself is never
 * removable (a no-op clone if `id` is the root or absent). */
export function removeNode(root: Container, id: string): Container {
	const prune = (c: Container): Container => ({
		...c,
		children: c.children
			.filter((child) => child.id !== id)
			.map((child) => (isContainer(child) ? prune(child) : child))
	});
	return prune(root);
}

/**
 * Move node `id` to be a child of `newParentId` at `index`. No-op (clone) when the node
 * is absent, when `newParentId` is the node itself, or when `newParentId` lies inside
 * the node's own subtree (which would create a cycle).
 */
export function moveNode(
	root: Container,
	id: string,
	newParentId: string,
	index?: number
): Container {
	if (id === newParentId) return root;
	const node = findNode(root, id);
	if (!node) return root;
	if (findNode(node, newParentId)) return root; // target is inside the moved subtree → cycle
	return insertChild(removeNode(root, id), newParentId, node, index);
}

/** Replace the node `id` (and its whole subtree) with `node`, in place. Returns a new root; a no-op
 * clone when `id` is absent. Replacing the root applies only when `node` is itself a container (a
 * leaf can't be the root). Used by the Inspector's Data tab to apply an edited JSON/YAML node. */
export function replaceNode(root: Container, id: string, node: LayoutNode): Container {
	if (root.id === id) return isContainer(node) ? node : root;
	const walk = (c: Container): Container => ({
		...c,
		children: c.children.map((child) =>
			child.id === id ? node : isContainer(child) ? walk(child) : child
		)
	});
	return walk(root);
}

/** Every leaf in the flow tree, in document order. (Leaf ids match the solver's keys at
 * the root prefix; group descendants are namespaced and handled by the solver itself.) */
export function flowLeaves(root: Container): Leaf[] {
	const out: Leaf[] = [];
	const walk = (c: Container): void => {
		for (const child of c.children) {
			if (isLeaf(child)) out.push(child);
			else if (isContainer(child)) walk(child);
		}
	};
	walk(root);
	return out;
}

/** All containers in the tree (root first), in document order — for outline rendering. */
export function allContainers(root: Container): Container[] {
	const out: Container[] = [root];
	const walk = (c: Container): void => {
		for (const child of c.children) {
			if (isContainer(child)) {
				out.push(child);
				walk(child);
			}
		}
	};
	walk(root);
	return out;
}

export type OutlineRow = {
	node: LayoutNode;
	depth: number;
	parentId: string;
	index: number; // position among its siblings
	siblingCount: number;
	// For each ANCESTOR lane between this row and the root (one entry per depth level, outermost
	// first), whether that ancestor is the LAST of its siblings. The tree view draws a continuing
	// vertical guide at a lane only when its ancestor is NOT last (i.e. more siblings follow below).
	ancestorsLast: boolean[];
};

/** Flatten the tree (excluding the root itself) into indented rows for an outline view.
 * Each row knows its parent + index (so the UI can enable/disable up/down/outdent) and the
 * last-child flags of its ancestors (so the UI can draw tree connector lines). */
export function outlineRows(root: Container): OutlineRow[] {
	const rows: OutlineRow[] = [];
	const walk = (c: Container, depth: number, ancestorsLast: boolean[]): void => {
		c.children.forEach((child, index) => {
			const isLast = index === c.children.length - 1;
			rows.push({
				node: child,
				depth,
				parentId: c.id,
				index,
				siblingCount: c.children.length,
				ancestorsLast
			});
			if (isContainer(child)) walk(child, depth + 1, [...ancestorsLast, isLast]);
		});
	};
	walk(root, 0, []);
	return rows;
}

/**
 * Ungroup the flow group leaf `groupId`: replace it with a clone of its concrete child
 * (the def's child when `groupId` references one, else the inline child). A no-op clone
 * when `groupId` isn't a group leaf; the group is removed if it has no resolvable child.
 * Pure (Phase 6a). Floating groups are ungrouped by the Canvas (placement-specific).
 */
export function ungroupNode(root: Container, groupId: string, library?: Library): Container {
	const node = findNode(root, groupId);
	if (!node || !isLeaf(node) || !isGroup(node.unit)) return root;
	const g = node.unit;
	const def = g.def && library ? library.defs.find((d) => d.id === g.def) : undefined;
	const baseChild = def ? def.child : g.child;
	if (!baseChild) return removeNode(root, groupId);
	return updateNode(root, groupId, () => clone(baseChild));
}

/** Whether a node holds a widget (a leaf) anywhere in its subtree. */
function hasLeaf(node: LayoutNode): boolean {
	return isLeaf(node) || (isContainer(node) && node.children.some(hasLeaf));
}

/**
 * Collapse a split container: flatten its child sub-cells ONE level (pull their children up) and
 * drop empty sub-cells — the inverse of the split op. A cell split into rows/columns and then
 * filled collapses back to holding its widgets directly; empty rows/columns simply vanish. Leaf
 * children are kept as-is; the container itself (and its grid-cell sizing) is preserved. Pure.
 */
export function collapseContainer(root: Container, id: string): Container {
	return updateNode(root, id, (n) => {
		if (!isContainer(n)) return n;
		const flat = n.children
			.flatMap((c) => (isContainer(c) ? c.children : [c]))
			.filter((c) => isLeaf(c) || hasLeaf(c));
		return { ...n, children: flat };
	});
}

export type Drop = {
	parentId: string;
	index: number;
	into?: boolean; // dropping INTO the parent container (highlight it), not beside a sibling
	merge?: string; // a grid cell that's a bare leaf: wrap it + the dropped node into a shared cell
};

/**
 * Dropping into an OCCUPIED grid cell's interior (the central region) targets that cell, so
 * widgets can share it (pair with the cell's `overlap` to layer them) instead of only inserting
 * before/after. A cell that's a container → drop into it; a cell that's a bare leaf → `merge`
 * (the Canvas wraps it + the dropped node into a new cell). Near the cell edges this returns null
 * and the caller falls back to before/after. Pure; needs the grid box from the solver.
 */
function gridCellInteriorDrop(
	root: Container,
	solved: Map<string, Rect>,
	point: { x: number; y: number },
	draggingId: string
): Drop | null {
	let best: Drop | null = null;
	let bestDepth = -1;
	const walk = (node: LayoutNode, depth: number): void => {
		if (!isContainer(node)) return;
		if (node.kind === 'grid') {
			const box = solved.get(node.id);
			if (box) {
				const cells = gridCellRects(node, box);
				for (let i = 0; i < node.children.length; i++) {
					const child = node.children[i];
					const cell = cells[i];
					if (!cell || child.id === draggingId) continue;
					// Central 60% of the cell only — the outer band stays "before/after" (reorder).
					const ix = cell.x + cell.w * 0.2;
					const iX = cell.x + cell.w * 0.8;
					const iy = cell.y + cell.h * 0.2;
					const iY = cell.y + cell.h * 0.8;
					if (point.x < ix || point.x >= iX || point.y < iy || point.y >= iY) continue;
					if (depth <= bestDepth) continue;
					bestDepth = depth;
					best = isContainer(child)
						? {
								parentId: child.id,
								index: child.children.filter((c) => c.id !== draggingId).length,
								into: true
						  }
						: { parentId: node.id, index: i, merge: child.id };
				}
			}
		}
		for (const c of node.children) walk(c, depth + 1);
	};
	walk(root, 0);
	return best;
}

/**
 * Where a drag would land in the flow tree, by hit-testing the dragged point against the
 * SOLVED rects of the flow leaves (skipping the one being dragged). Returns the target
 * parent + insertion index (already excluding the dragged node, so it feeds straight into
 * `moveNode`), or null when the point isn't over any flow leaf (the Canvas treats null as
 * "float"). Insertion side is the near half along the parent's main axis (col → y, else x).
 * Pure (Phase 5e).
 */
export function dropTarget(
	root: Container,
	solved: Map<string, Rect>,
	point: { x: number; y: number },
	draggingId: string,
	intoCells = true
): Drop | null {
	// Dropping into an occupied grid cell's interior wins over before/after a leaf (when enabled).
	if (intoCells) {
		const cellDrop = gridCellInteriorDrop(root, solved, point, draggingId);
		if (cellDrop) return cellDrop;
	}
	for (const lf of flowLeaves(root)) {
		if (lf.id === draggingId) continue;
		const r = solved.get(lf.id);
		if (!r) continue;
		if (point.x < r.x || point.x >= r.x + r.w || point.y < r.y || point.y >= r.y + r.h) continue;
		const parent = findParent(root, lf.id);
		if (!parent) continue;
		const after = parent.kind === 'col' ? point.y >= r.y + r.h / 2 : point.x >= r.x + r.w / 2;
		const siblings = parent.children.filter((c) => c.id !== draggingId);
		const ti = siblings.findIndex((c) => c.id === lf.id);
		return { parentId: parent.id, index: ti + (after ? 1 : 0) };
	}
	// Not over a leaf: fall into the DEEPEST non-root container the point is inside (e.g. an
	// empty grid/row/col the user just added), appending at its end. The root is excluded so a
	// drop on bare canvas still floats. Container boxes come from the solver (it emits them).
	// `best` is a holder object so its fields survive the closure (TS can't narrow a let here).
	const best = { id: '', depth: -1, count: 0, found: false };
	const walk = (node: LayoutNode, depth: number): void => {
		if (!isContainer(node)) return;
		const r = solved.get(node.id);
		// The root is normally excluded (a bare-canvas drop floats) — EXCEPT a grid root, whose
		// cells are explicit drop targets, so dropping into it should dock, not float.
		if (
			(node.id !== root.id || node.kind === 'grid') &&
			node.id !== draggingId &&
			r &&
			point.x >= r.x &&
			point.x < r.x + r.w &&
			point.y >= r.y &&
			point.y < r.y + r.h &&
			depth > best.depth
		) {
			best.id = node.id;
			best.depth = depth;
			best.count = node.children.filter((c) => c.id !== draggingId).length;
			best.found = true;
		}
		for (const c of node.children) walk(c, depth + 1);
	};
	walk(root, 0);
	return best.found ? { parentId: best.id, index: best.count } : null;
}
