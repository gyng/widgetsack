// The editor model's pure op helpers — ported VERBATIM from Canvas.svelte (via useEditorModel).
// Each takes the current EditorState and returns a Patch (the new monitor/library/selection);
// none of them touch React, history, or disk — the reducer's commit chokepoint does that. Grouped
// by concern: flow-tree edits, floating + dock, defs + library, tokens + background, widget
// patches + bulk/selection. `floatNode` needs the live solved map at call time; the Canvas
// injects it via setSolvedForFloat (a module-level ref) before dispatch.
import { type Rect, type WidgetInstance } from '../../core/layout';
import { createWidget, getMeta } from '../../core/widget';
import {
	container,
	group,
	isContainer,
	isGroup,
	isLeaf,
	leaf,
	NEW_CONTAINER_GAP,
	type AlignH,
	type AlignV,
	type BackgroundSpec,
	type Container,
	type Group,
	type Leaf,
	type LayoutNode,
	type Length,
	type Library,
	type MonitorLayout,
	type Pad,
	type WidgetDef
} from '../../core/layoutTree';
import {
	findNode,
	findParent,
	insertChild,
	moveNode,
	removeNode,
	replaceNode,
	ungroupNode,
	updateContainer,
	updateNode
} from '../../core/layoutEdit';
import { intrinsicSize, type Solved } from '../../core/solve';
import { freshIds, getTemplate, instantiateTemplate } from '../../core/templates';
import { dropPlacement } from './dropPlacement';
import type { EditorState } from './types';

export const rand = (): string => Math.random().toString(36).slice(2, 8);
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const cfgNum = (c: Record<string, unknown> | undefined, k: string): number =>
	typeof c?.[k] === 'number' ? (c[k] as number) : 0;

// A patch the reducer applies. `commit` (the `op` action flag) = this was a `saveLayout()`
// chokepoint (record undo + bump saveSeq). Selection-only edits leave it false.
export type Patch = Partial<EditorState>;

// --- selection lookup (shared with the Canvas's derived state) ------------------------------

export function lookup(id: string, m: MonitorLayout): LayoutNode | null {
	return findNode(m.root, id) ?? m.floating.find((l) => l.id === id) ?? null;
}

// The selected container (incl. root) in the live tree — used by addWidget/addContainer/insert.
export function currentContainer(s: EditorState): Container | null {
	if (!s.selectedId) return null;
	const node = lookup(s.selectedId, s.monitor);
	return node && isContainer(node) ? node : null;
}

// The ids of the current selection (the marquee set, else the single primary). Shared by the bulk
// multi-select edits so they act on exactly what's highlighted, in ONE commit (one undo step).
function selectionIds(s: EditorState): string[] {
	return s.selectedIds.length ? s.selectedIds : s.selectedId ? [s.selectedId] : [];
}

// =============================================================================================
// Flow-tree edits: add/split/remove/reorder containers + widgets inside the tree.
// =============================================================================================

export function wrapLeafWith(
	root: Container,
	targetId: string,
	removeId: string,
	node: LayoutNode
): Container {
	const pruned = findNode(root, removeId) ? removeNode(root, removeId) : root;
	return updateNode(pruned, targetId, (n) =>
		container(`cell-${rand()}`, 'col', [n, node], { align: 'stretch', overlap: true })
	);
}

export function dropWidgetInto(s: EditorState, containerId: string, widgetType: string): Patch {
	const id = `${widgetType}-${rand()}`;
	return {
		monitor: {
			...s.monitor,
			root: insertChild(s.monitor.root, containerId, leaf(createWidget(widgetType, id)))
		},
		selectedId: id
	};
}

export function reparentNode(s: EditorState, id: string, containerId: string): Patch {
	if (id === containerId) return {};
	const node = findNode(s.monitor.root, id);
	if (node && isContainer(node) && findNode(node, containerId)) return {};
	const fl = s.monitor.floating.find((l) => l.id === id);
	if (fl) {
		return {
			monitor: {
				...s.monitor,
				floating: s.monitor.floating.filter((l) => l.id !== id),
				root: insertChild(s.monitor.root, containerId, fl)
			},
			selectedId: id
		};
	}
	return {
		monitor: { ...s.monitor, root: moveNode(s.monitor.root, id, containerId) },
		selectedId: id
	};
}

// Replace node `id` wholesale with `node` (the Inspector Data tab). Floating leaves swap in the
// floating array; flow nodes swap in the tree. The Inspector coerces the node's id to `id`.
export function replaceNodeOp(s: EditorState, id: string, node: LayoutNode): Patch {
	if (s.monitor.floating.some((l) => l.id === id)) {
		return {
			monitor: {
				...s.monitor,
				floating: s.monitor.floating.map((l) => (l.id === id ? (node as Leaf) : l))
			},
			selectedId: id
		};
	}
	return {
		monitor: { ...s.monitor, root: replaceNode(s.monitor.root, id, node) },
		selectedId: id
	};
}

export function addWidget(s: EditorState, type: string): Patch {
	const selectedContainer = currentContainer(s);
	const id = `${type}-${rand()}`;
	const w = leaf(createWidget(type, id));
	const monitor = selectedContainer
		? { ...s.monitor, root: insertChild(s.monitor.root, selectedContainer.id, w) }
		: { ...s.monitor, floating: [...s.monitor.floating, w] };
	return { monitor, selectedId: id };
}

// Drop a palette widget onto the stage: a new FLOATING widget centered on the drop point (item 7).
export function addWidgetAt(s: EditorState, type: string, x: number, y: number): Patch {
	const id = `${type}-${rand()}`;
	const inst = createWidget(type, id);
	const at = dropPlacement(inst.rect, x, y);
	const w = leaf({ ...inst, rect: { ...inst.rect, x: at.x, y: at.y } });
	return {
		monitor: { ...s.monitor, floating: [...s.monitor.floating, w] },
		selectedId: id
	};
}

// Build a fresh container of `kind`: an empty row/col, or a 2×2 grid of col cells. Shared by the
// "Add inside" (addContainer) and "Add beside" (addBeside) paths so both produce identical bands.
// New containers carry the default gap so freshly dropped widgets never start fused edge-to-edge
// (every built-in template overrides 0 — nothing actually wants it); the Inspector zeroes it in one
// step for the dense-cluster cases.
function newContainerOfKind(kind: Container['kind'], id: string): Container {
	if (kind === 'grid') {
		const cols = 2;
		const rows = 2;
		const cells = Array.from({ length: cols * rows }, () =>
			container(`cell-${rand()}`, 'col', [], { align: 'stretch', gap: NEW_CONTAINER_GAP })
		);
		return container(id, 'grid', cells, {
			cols,
			rows,
			gap: NEW_CONTAINER_GAP,
			basis: { fr: 1 },
			align: 'stretch'
		});
	}
	return container(id, kind, [], { gap: NEW_CONTAINER_GAP, basis: { fr: 1 }, align: 'stretch' });
}

// Insert a new child container of `kind` into `containerId` (or the selected container / root). Used
// by the Outline's +Row/+Col/+Grid (selected) and the container context menu's Add (right-clicked).
export function addContainer(
	s: EditorState,
	kind: Container['kind'],
	containerId?: string,
	index?: number
): Patch {
	const target = containerId ?? currentContainer(s)?.id ?? s.monitor.root.id;
	// Only a real container can hold children; bail if the id isn't one (e.g. a stale menu target).
	const targetNode = findNode(s.monitor.root, target);
	if (!targetNode || !isContainer(targetNode)) return {};
	const id = `${kind}-${rand()}`;
	let root = s.monitor.root;
	// Cell-targeted (grid): pad the earlier empty cells with spacer containers so the new band lands in
	// the CLICKED cell rather than the first free one. (`index` only ever exceeds the child count for an
	// empty trailing cell — see collectGridPlaceholders.)
	if (index !== undefined && index > targetNode.children.length) {
		for (let i = targetNode.children.length; i < index; i++) {
			root = insertChild(
				root,
				target,
				container(`cell-${rand()}`, 'col', [], { align: 'stretch', gap: NEW_CONTAINER_GAP })
			);
		}
	}
	root = insertChild(root, target, newContainerOfKind(kind, id), index);
	root = updateContainer(root, target, { align: 'stretch' });
	return { monitor: { ...s.monitor, root }, selectedId: id };
}

// Insert a new sibling container of `kind` directly AFTER node `id`, in id's parent — the context
// menu's "Add beside". Mirrors addContainer but targets the parent + an index, so the band lands
// next to the right-clicked one rather than inside it. No-op at the root (it has no siblings) or
// when the id isn't in the tree.
export function addBeside(s: EditorState, id: string, kind: Container['kind']): Patch {
	const parent = findParent(s.monitor.root, id);
	if (!parent) return {};
	const newId = `${kind}-${rand()}`;
	const idx = parent.children.findIndex((ch) => ch.id === id);
	let root = insertChild(s.monitor.root, parent.id, newContainerOfKind(kind, newId), idx + 1);
	root = updateContainer(root, parent.id, { align: 'stretch' });
	return { monitor: { ...s.monitor, root }, selectedId: newId };
}

// Split cells carry basis fr:1 so they SHARE the box evenly — an empty cell with basis 'auto'
// has ~0 intrinsic extent and (no fr) gets no leftover, collapsing to 0 height/width.
const splitCell = (kind: Container['kind']): Container =>
	container(`cell-${rand()}`, kind, [], {
		align: 'stretch',
		gap: NEW_CONTAINER_GAP,
		basis: { fr: 1 }
	});

// The new band CONTAINER a split produces (no existing content to keep): for 'rows' a col of two
// rows, for 'cols' a row of two cols, for 'grid' a fresh 2×2 grid.
function splitBandContainer(dir: 'rows' | 'cols' | 'grid'): Container {
	if (dir === 'grid') return newContainerOfKind('grid', `grid-${rand()}`);
	const parentKind: Container['kind'] = dir === 'rows' ? 'col' : 'row';
	const bandKind: Container['kind'] = dir === 'rows' ? 'row' : 'col';
	return container(`cell-${rand()}`, parentKind, [splitCell(bandKind), splitCell(bandKind)], {
		align: 'stretch',
		gap: NEW_CONTAINER_GAP,
		basis: { fr: 1 }
	});
}

// Split an EMPTY grid placeholder (cell `index` of `grid`): materialise the band container AT that
// cell — padding any earlier empty cells like addContainer — instead of splitting the whole grid
// (which would wrongly wrap the grid a level deeper). Used when the split op carries a cellIndex.
function splitGridCell(
	s: EditorState,
	grid: Container,
	index: number,
	dir: 'rows' | 'cols' | 'grid'
): Patch {
	const band = splitBandContainer(dir);
	let root = s.monitor.root;
	if (index > grid.children.length) {
		for (let i = grid.children.length; i < index; i++) {
			root = insertChild(root, grid.id, splitCell('col'));
		}
	}
	root = insertChild(root, grid.id, band, index);
	root = updateContainer(root, grid.id, { align: 'stretch' });
	return { monitor: { ...s.monitor, root }, selectedId: band.id };
}

export function splitNode(
	s: EditorState,
	id: string,
	dir: 'rows' | 'cols' | 'grid',
	cellIndex?: number
): Patch {
	const node = findNode(s.monitor.root, id);
	if (!node || !isContainer(node)) return {};
	// An empty grid cell (placeholder) carries a cellIndex: split THAT cell, not the whole grid.
	if (cellIndex !== undefined && node.kind === 'grid') {
		return splitGridCell(s, node, cellIndex, dir);
	}
	const cell = splitCell;
	// `keep` wraps the EXISTING content, so it preserves the node's own kind (re-kinding it would
	// re-flow what's already there). The new empty cells take the BAND orientation (see below).
	const keep = node.children.length
		? container(`cell-${rand()}`, node.kind, node.children, {
				align: node.align ?? 'stretch',
				basis: { fr: 1 },
				cols: node.cols,
				rows: node.rows,
				gap: node.gap,
				pad: node.pad,
				justify: node.justify
			})
		: null;
	let patch: Partial<Container>;
	if (dir === 'grid') {
		const cells = Array.from({ length: 4 }, () => cell('col'));
		if (keep) cells[0] = keep;
		patch = { kind: 'grid', cols: 2, rows: 2, children: cells };
	} else {
		// "into rows" → a COL parent (stacks vertically) holding ROW bands; "into cols" → a ROW parent
		// holding COL strips. So each band's own kind IS the thing the user asked to create.
		const parentKind: Container['kind'] = dir === 'rows' ? 'col' : 'row';
		const bandKind: Container['kind'] = dir === 'rows' ? 'row' : 'col';
		patch = {
			kind: parentKind,
			cols: undefined,
			rows: undefined,
			children: keep ? [keep, cell(bandKind)] : [cell(bandKind), cell(bandKind)]
		};
	}
	const patched: Container = {
		...node,
		...patch,
		align: 'stretch',
		basis: node.basis ?? { fr: 1 }
	};
	const monitor = { ...s.monitor, root: updateNode(s.monitor.root, id, () => patched) };
	const kids = patched.children;
	return { monitor, selectedId: (keep ? kids[kids.length - 1] : kids[0]).id };
}

export function removeById(s: EditorState, id: string): Patch {
	const monitor = s.monitor.floating.some((l) => l.id === id)
		? { ...s.monitor, floating: s.monitor.floating.filter((l) => l.id !== id) }
		: { ...s.monitor, root: removeNode(s.monitor.root, id) };
	const patch: Patch = { monitor };
	// Match Svelte's net selection result: removing the PRIMARY collapsed the whole marquee (the
	// `$: syncSelectionPrimary(selectedId)` reactive set selectedIds=[] when selectedId went null);
	// removing a non-primary member just filters it out.
	if (s.selectedId === id) {
		patch.selectedId = null;
		patch.selectedIds = [];
	} else if (s.selectedIds.includes(id)) {
		patch.selectedIds = s.selectedIds.filter((x) => x !== id);
	}
	return patch;
}

export function reorder(s: EditorState, id: string, delta: number): Patch {
	const parent = findParent(s.monitor.root, id);
	if (!parent) return {};
	const idx = parent.children.findIndex((c) => c.id === id);
	const ni = idx + delta;
	if (ni < 0 || ni >= parent.children.length) return {};
	return { monitor: { ...s.monitor, root: moveNode(s.monitor.root, id, parent.id, ni) } };
}

export function outdent(s: EditorState, id: string): Patch {
	const parent = findParent(s.monitor.root, id);
	if (!parent || parent.id === s.monitor.root.id) return {};
	const grand = findParent(s.monitor.root, parent.id);
	if (!grand) return {};
	const pidx = grand.children.findIndex((c) => c.id === parent.id);
	return { monitor: { ...s.monitor, root: moveNode(s.monitor.root, id, grand.id, pidx + 1) } };
}

export function indent(s: EditorState, id: string): Patch {
	const parent = findParent(s.monitor.root, id);
	if (!parent) return {};
	const idx = parent.children.findIndex((c) => c.id === id);
	const prev = parent.children[idx - 1];
	if (!prev || !isContainer(prev)) return {};
	return { monitor: { ...s.monitor, root: moveNode(s.monitor.root, id, prev.id) } };
}

export function patchContainerOp(s: EditorState, id: string, patch: Partial<Container>): Patch {
	let root = updateContainer(s.monitor.root, id, patch);
	// Resizing a GRID (its cols/rows) must DROP the cells that no longer fit — otherwise reducing the
	// grid does nothing, because solve.ts's gridRows() just grows the row count back to hold the
	// orphaned children. Trim from the end (grids fill row-major) down to the new cols×rows.
	if (patch.cols !== undefined || patch.rows !== undefined) {
		const node = findNode(root, id);
		if (node && isContainer(node) && node.kind === 'grid') {
			const cap = Math.max(1, node.cols ?? 1) * Math.max(1, node.rows ?? 1);
			if (node.children.length > cap) {
				root = updateNode(
					root,
					id,
					(n) => ({ ...n, children: (n as Container).children.slice(0, cap) }) as LayoutNode
				);
			}
		}
	}
	return { monitor: { ...s.monitor, root } };
}

// Set (or clear, when undefined) a flow node's main-axis basis: 'auto'/px = fixed, {fr} = grow.
// Works on any node in the flow tree (a widget leaf or a container); floating leaves ignore basis.
export function setNodeBasis(s: EditorState, id: string, basis: Length | undefined): Patch {
	const root = updateNode(s.monitor.root, id, (n) => {
		const next = { ...n } as LayoutNode & { basis?: Length };
		if (basis === undefined) delete next.basis;
		else next.basis = basis;
		return next;
	});
	return { monitor: { ...s.monitor, root } };
}

// Set per-node main-axis basis in ONE pass (one commit). Used by the splitter drag (two children's
// fr at once) and Distribute-evenly. Unknown ids are skipped by updateNode.
export function setNodeBases(s: EditorState, entries: { id: string; basis: Length }[]): Patch {
	let root = s.monitor.root;
	for (const { id, basis } of entries) {
		root = updateNode(root, id, (n) => ({ ...n, basis }) as LayoutNode);
	}
	return { monitor: { ...s.monitor, root } };
}

// Reset a container to an EVEN distribution. For a row/col: every child basis → {fr:1}. For a GRID:
// clear the per-track colFr/rowFr weights so the flexible columns/rows go back to a uniform split
// (the easy "reset" for dragged grid tracks — also reachable by double-clicking a grid splitter).
export function distributeEvenly(s: EditorState, containerId: string): Patch {
	const node = findNode(s.monitor.root, containerId);
	if (!node || !isContainer(node) || node.children.length === 0) return {};
	if (node.kind === 'grid') {
		const root = updateContainer(s.monitor.root, containerId, {
			colFr: undefined,
			rowFr: undefined
		});
		return { monitor: { ...s.monitor, root } };
	}
	return setNodeBases(
		s,
		node.children.map((c) => ({ id: c.id, basis: { fr: 1 } as Length }))
	);
}

// Set fr weights on specific FLEXIBLE tracks of a grid (the grid-splitter drag/commit + keyboard +
// double-click reset). Reads/creates the colFr/rowFr array (defaulting absent tracks to weight 1),
// writes the given indices, and stores it back. A no-op when `gridId` isn't a grid.
export function setGridTracks(
	s: EditorState,
	gridId: string,
	which: 'col' | 'row',
	entries: { index: number; fr: number }[]
): Patch {
	const node = findNode(s.monitor.root, gridId);
	if (!node || !isContainer(node) || node.kind !== 'grid') return {};
	const key = which === 'col' ? 'colFr' : 'rowFr';
	const cur = node[key];
	const maxIdx = entries.reduce((m, e) => Math.max(m, e.index), -1);
	const hint = which === 'col' ? Math.max(1, node.cols ?? 1) : Math.max(1, node.rows ?? 1);
	const count = Math.max(hint, cur?.length ?? 0, maxIdx + 1);
	const next = Array.from({ length: count }, (_, i) => {
		const w = cur?.[i];
		return typeof w === 'number' && w > 0 ? w : 1;
	});
	for (const e of entries) {
		if (e.index >= 0 && e.index < count) next[e.index] = Number(e.fr.toFixed(3));
	}
	return {
		monitor: { ...s.monitor, root: updateContainer(s.monitor.root, gridId, { [key]: next }) }
	};
}

// Set a leaf's placement (halign/valign) within the box the layout gives it. 'fill' (the default)
// clears the field so the leaf spans the box; the others pin it to a screen edge/center. A no-op
// on non-leaf nodes (containers align their children via align/justify instead).
export function setLeafAlign(s: EditorState, id: string, halign: AlignH, valign: AlignV): Patch {
	const root = updateNode(s.monitor.root, id, (n) => {
		if (!isLeaf(n)) return n;
		const next = { ...n } as Leaf & { halign?: AlignH; valign?: AlignV };
		if (halign === 'fill') delete next.halign;
		else next.halign = halign;
		if (valign === 'fill') delete next.valign;
		else next.valign = valign;
		return next;
	});
	return { monitor: { ...s.monitor, root } };
}

// Set a flow leaf's per-side margin (outer space) or padding (inner inset); `value` undefined clears
// the field. Mirrors setLeafAlign — flow only, since floating leaves are absolutely positioned and
// don't participate in the flow where margin/pad apply.
export function setLeafBox(
	s: EditorState,
	id: string,
	field: 'margin' | 'pad',
	value: Pad | undefined
): Patch {
	const root = updateNode(s.monitor.root, id, (n) => {
		if (!isLeaf(n)) return n;
		const next = { ...n } as Leaf & { margin?: Pad; pad?: Pad };
		if (value === undefined) delete next[field];
		else next[field] = value;
		return next;
	});
	return { monitor: { ...s.monitor, root } };
}

// =============================================================================================
// Floating + dock: move leaves between the floating layer and the flow tree.
// =============================================================================================

export function floatingLeafFrom(node: Leaf, x: number, y: number, r?: Rect): Leaf {
	if (!isGroup(node.unit)) {
		const u = node.unit;
		return leaf({ ...u, rect: { x, y, w: r?.w ?? u.rect.w, h: r?.h ?? u.rect.h } });
	}
	const g = node.unit;
	return leaf({ ...g, config: { ...g.config, x, y } });
}

export function dock(s: EditorState, id: string): Patch {
	const lf = s.monitor.floating.find((l) => l.id === id);
	if (!lf) return {};
	return {
		monitor: {
			...s.monitor,
			floating: s.monitor.floating.filter((l) => l.id !== id),
			root: insertChild(s.monitor.root, s.monitor.root.id, lf)
		},
		selectedId: id
	};
}

// floatNode needs `solved` at call time; the Canvas drag paths pass the solved map in, but the
// handleOp `float` case (from Inspector/Outline/menu) has no point arg. Mirror the Svelte version:
// it reads the live `solved` (a Canvas reactive). Here we recompute from monitor+workArea would be
// wrong (no workArea here), so the Canvas injects `solved` via a module-level ref before dispatch.
let solvedRef: Solved = new Map();
export function setSolvedForFloat(s: Solved): void {
	solvedRef = s;
}
export function floatNode(s: EditorState, id: string, at?: { x: number; y: number }): Patch {
	const node = findNode(s.monitor.root, id);
	if (!node || !isLeaf(node)) return {};
	const r = solvedRef.get(id);
	const lf = floatingLeafFrom(node, at?.x ?? r?.x ?? 0, at?.y ?? r?.y ?? 0, r);
	return {
		monitor: {
			...s.monitor,
			root: removeNode(s.monitor.root, id),
			floating: [...s.monitor.floating, lf]
		},
		selectedId: id
	};
}

// =============================================================================================
// Defs + library: make/insert/ungroup grouped widgets, def metadata, templates.
// =============================================================================================

export function makeWidget(s: EditorState, id: string): Patch {
	const node = lookup(id, s.monitor);
	if (!node) return {};
	const sz = intrinsicSize(node, s.library);
	const size = {
		w: Math.max(40, Math.round(sz.w) || 120),
		h: Math.max(24, Math.round(sz.h) || 80)
	};
	const defId = `def-${rand()}`;
	const name = isContainer(node) ? `widget-${node.kind}` : (node.unit as WidgetInstance).type;
	const def: WidgetDef = { id: defId, name, size, child: clone(node) };
	const library: Library = {
		version: s.library?.version ?? 1,
		defs: [...(s.library?.defs ?? []), def]
	};

	const grpId = `grp-${rand()}`;
	const floatingLeaf = s.monitor.floating.find((l) => l.id === id);
	if (floatingLeaf && isLeaf(floatingLeaf) && !isGroup(floatingLeaf.unit)) {
		const r = (floatingLeaf.unit as WidgetInstance).rect;
		const g = group(grpId, size, clone(node), { def: defId, name, config: { x: r.x, y: r.y } });
		return {
			library,
			monitor: {
				...s.monitor,
				floating: s.monitor.floating.map((l) => (l.id === id ? leaf(g) : l))
			},
			selectedId: grpId
		};
	}
	const g = group(grpId, size, clone(node), { def: defId, name });
	return {
		library,
		monitor: { ...s.monitor, root: updateNode(s.monitor.root, id, () => leaf(g)) },
		selectedId: grpId
	};
}

export function ungroupSelected(s: EditorState, id: string): Patch {
	const fl = s.monitor.floating.find((l) => l.id === id);
	if (fl) {
		if (!isGroup(fl.unit)) return {};
		const g = fl.unit;
		const def = g.def && s.library ? s.library.defs.find((d) => d.id === g.def) : undefined;
		const base = def ? def.child : g.child;
		if (base && isLeaf(base) && !isGroup(base.unit)) {
			const u = clone(base.unit) as WidgetInstance;
			u.rect = { ...u.rect, x: cfgNum(g.config, 'x'), y: cfgNum(g.config, 'y') };
			return {
				monitor: {
					...s.monitor,
					floating: s.monitor.floating.map((l) => (l.id === id ? leaf(u) : l))
				},
				selectedId: u.id
			};
		}
		console.warn('ungroup: dock this composite group into the flow first');
		return {};
	}
	return {
		monitor: { ...s.monitor, root: ungroupNode(s.monitor.root, id, s.library) },
		selectedId: null
	};
}

export function insertWidget(s: EditorState, defId: string): Patch {
	const def = s.library?.defs.find((d) => d.id === defId);
	if (!def) return {};
	const grpId = `grp-${rand()}`;
	const g = group(grpId, def.size, clone(def.child), { def: defId, name: def.name });
	// Dock the placed group into the selected container, else the monitor's flow ROOT — widgets join
	// the rows/columns layout instead of the floating layer (right-click → Float to escape the flow).
	const target = currentContainer(s)?.id ?? s.monitor.root.id;
	return {
		monitor: { ...s.monitor, root: insertChild(s.monitor.root, target, leaf(g)) },
		selectedId: grpId
	};
}

// Fresh-id remapping for template trees now lives in core (templates.freshIds); re-exported here so
// the model keeps one import surface for its op helpers.
export { freshIds };

// Instantiate a built-in template directly onto the canvas as a SELF-CONTAINED group: the template's
// flow tree (fresh ids) lives inline on the group with no library `def`, so repeat inserts stay
// independent and the library isn't cluttered (resolveGroup renders the inline child when there's no
// def; the user can "Make widget" later to promote it). Docks into the selected container, else the
// flow root — mirrors insertWidget minus the library lookup.
export function insertTemplate(
	s: EditorState,
	templateId: string,
	options?: Record<string, string>
): Patch {
	const t = getTemplate(templateId);
	if (!t) return {};
	const grpId = `grp-${rand()}`;
	const g = group(grpId, t.size, freshIds(instantiateTemplate(t, options)), {
		name: t.name
	});
	const target = currentContainer(s)?.id ?? s.monitor.root.id;
	return {
		monitor: { ...s.monitor, root: insertChild(s.monitor.root, target, leaf(g)) },
		selectedId: grpId
	};
}

export function defInUse(s: EditorState, defId: string): boolean {
	let used = false;
	const visit = (n: LayoutNode): void => {
		if (isLeaf(n)) {
			if (isGroup(n.unit) && n.unit.def === defId) used = true;
		} else {
			n.children.forEach(visit);
		}
	};
	const scan = (mon: MonitorLayout): void => {
		visit(mon.root);
		mon.floating.forEach(visit);
	};
	// Check the REAL monitor (stashed in savedMonitor while designing another def) plus, if designing,
	// the scoped editing tree (a composite def could embed this one) — never just the scoped tree.
	scan(s.editingDefId != null && s.savedMonitor ? s.savedMonitor : s.monitor);
	if (s.editingDefId != null) scan(s.monitor);
	return used;
}

export function renameDef(s: EditorState, defId: string, name: string): Patch {
	if (!s.library) return {};
	return {
		library: {
			...s.library,
			defs: s.library.defs.map((d) => (d.id === defId ? { ...d, name } : d))
		}
	};
}

export function deleteDef(s: EditorState, defId: string): Patch {
	if (!s.library) return {};
	if (s.editingDefId === defId) {
		console.warn(`def ${defId} is being edited; not deleted`);
		return {};
	}
	if (defInUse(s, defId)) {
		console.warn(`def ${defId} is in use; not deleted`);
		return {};
	}
	return { library: { ...s.library, defs: s.library.defs.filter((d) => d.id !== defId) } };
}

export function addDefParam(s: EditorState, defId: string, key: string, target?: string): Patch {
	if (!s.library || !key) return {};
	return {
		library: {
			...s.library,
			defs: s.library.defs.map((d) =>
				d.id === defId
					? { ...d, params: [...(d.params ?? []), { key, target: target || undefined }] }
					: d
			)
		}
	};
}

export function patchGroup(s: EditorState, id: string, patch: Partial<Group>): Patch {
	const merge = (g: Group): Group => ({ ...g, ...patch });
	if (s.monitor.floating.some((l) => l.id === id)) {
		return {
			monitor: {
				...s.monitor,
				floating: s.monitor.floating.map((l) =>
					l.id === id && isGroup(l.unit) ? { ...l, unit: merge(l.unit) } : l
				)
			}
		};
	}
	return {
		monitor: {
			...s.monitor,
			root: updateNode(s.monitor.root, id, (n) =>
				isLeaf(n) && isGroup(n.unit) ? { ...n, unit: merge(n.unit) } : n
			)
		}
	};
}

export function setDefSize(s: EditorState, defId: string, w: number, h: number): Patch {
	if (!s.library) return {};
	const size = { w: Math.max(8, w), h: Math.max(8, h) };
	return {
		library: {
			...s.library,
			defs: s.library.defs.map((d) => (d.id === defId ? { ...d, size } : d))
		}
	};
}

export function setDefCss(s: EditorState, defId: string, css: string): Patch {
	if (!s.library) return {};
	return {
		library: {
			...s.library,
			defs: s.library.defs.map((d) => (d.id === defId ? { ...d, css: css || undefined } : d))
		}
	};
}

// =============================================================================================
// Tokens + background: global/per-widget theme token overrides + the monitor background layer.
// =============================================================================================

export function setToken(s: EditorState, key: string, value: string): Patch {
	const next = { ...s.tokenOverrides };
	if (value) next[key] = value;
	else delete next[key];
	return { tokenOverrides: next };
}

// Apply a whole map of global token overrides at once (the wallpaper auto-theme). Merges over the
// existing overrides — a key with an empty value clears it. Empty map → {} (no undo entry).
export function setTokens(s: EditorState, tokens: Record<string, string>): Patch {
	const keys = Object.keys(tokens);
	if (keys.length === 0) return {};
	const next = { ...s.tokenOverrides };
	for (const k of keys) {
		if (tokens[k]) next[k] = tokens[k];
		else delete next[k];
	}
	return { tokenOverrides: next };
}

// Drop every global token override in one op (the panel's "Clear overrides" button). Returns an
// empty patch when there's nothing to clear so it doesn't push a no-op entry onto the undo history.
export function clearTokens(s: EditorState): Patch {
	return Object.keys(s.tokenOverrides).length ? { tokenOverrides: {} } : {};
}

// Set (or clear, when spec is undefined) the current monitor's full-screen background layer. Lives on
// the monitor so it persists in widgets.json and rides the same commit/undo path as any layout edit.
export function setBackground(s: EditorState, spec: BackgroundSpec | undefined): Patch {
	if (!spec && !s.monitor.background) return {}; // clearing an already-empty background: no-op
	const monitor = { ...s.monitor };
	if (spec) monitor.background = spec;
	else delete monitor.background;
	return { monitor };
}

// Per-widget token override (the Inspector's "Override theme for this widget"): merge `key`→`value`
// into the selected unit's own `tokens` (delete the key when value is empty; drop the whole object
// when it empties out). Works on a primitive widget OR a group, in the flow tree or the floating
// layer — routed through the existing patchUnit/patchGroup so it rides the same commit/undo path.
export function setWidgetToken(s: EditorState, id: string, key: string, value: string): Patch {
	const node = lookup(id, s.monitor);
	if (!node || !isLeaf(node)) return {};
	const cur = node.unit.tokens ?? {};
	const next: Record<string, string> = { ...cur };
	if (value) next[key] = value;
	else delete next[key];
	const tokens = Object.keys(next).length ? next : undefined;
	return isGroup(node.unit) ? patchGroup(s, id, { tokens }) : patchUnit(s, id, { tokens });
}

// Drop ALL of a widget's/group's per-widget token overrides at once (the Inspector "Clear" button).
export function clearWidgetTokens(s: EditorState, id: string): Patch {
	const node = lookup(id, s.monitor);
	if (!node || !isLeaf(node) || !node.unit.tokens) return {};
	return isGroup(node.unit)
		? patchGroup(s, id, { tokens: undefined })
		: patchUnit(s, id, { tokens: undefined });
}

// =============================================================================================
// Widget patches + bulk/selection edits.
// =============================================================================================

export function patchFloating(s: EditorState, id: string, patch: Partial<WidgetInstance>): Patch {
	return {
		monitor: {
			...s.monitor,
			floating: s.monitor.floating.map((l) =>
				l.id === id && !isGroup(l.unit)
					? { ...l, unit: { ...(l.unit as WidgetInstance), ...patch } }
					: l
			)
		}
	};
}

export function patchUnit(s: EditorState, id: string, patch: Partial<WidgetInstance>): Patch {
	if (s.monitor.floating.some((l) => l.id === id)) return patchFloating(s, id, patch);
	return {
		monitor: {
			...s.monitor,
			root: updateNode(s.monitor.root, id, (n) =>
				isLeaf(n) && !isGroup(n.unit)
					? { ...n, unit: { ...(n.unit as WidgetInstance), ...patch } }
					: n
			)
		}
	};
}

// Set one config key on EVERY selected primitive widget (flow + floating). One commit → one undo.
export function bulkPatchConfig(s: EditorState, key: string, value: unknown): Patch {
	const ids = new Set(selectionIds(s));
	if (!ids.size) return {};
	const apply = (u: WidgetInstance): WidgetInstance => ({
		...u,
		config: { ...u.config, [key]: value }
	});
	const floating = s.monitor.floating.map((l) =>
		ids.has(l.id) && !isGroup(l.unit) ? { ...l, unit: apply(l.unit as WidgetInstance) } : l
	);
	let root = s.monitor.root;
	for (const id of ids) {
		root = updateNode(root, id, (n) =>
			isLeaf(n) && !isGroup(n.unit) ? { ...n, unit: apply(n.unit as WidgetInstance) } : n
		);
	}
	return { monitor: { ...s.monitor, root, floating } };
}

// Set the main-axis basis on every selected FLOW leaf (floating leaves ignore basis). One commit.
export function bulkSetBasis(s: EditorState, basis: Length | undefined): Patch {
	const ids = selectionIds(s);
	if (!ids.length) return {};
	let root = s.monitor.root;
	for (const id of ids) {
		root = updateNode(root, id, (n) => {
			const next = { ...n } as LayoutNode & { basis?: Length };
			if (basis === undefined) delete next.basis;
			else next.basis = basis;
			return next;
		});
	}
	return { monitor: { ...s.monitor, root } };
}

export function resetWidget(s: EditorState, id: string): Patch {
	const node = lookup(id, s.monitor);
	if (!node || !isLeaf(node) || isGroup(node.unit)) return {};
	const meta = getMeta((node.unit as WidgetInstance).type);
	return patchUnit(s, id, {
		config: { ...meta?.defaultConfig },
		css: meta?.defaultCss,
		sensor: meta?.defaultSensor
	});
}
