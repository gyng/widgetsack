import {
	isContainer,
	isGroup,
	isLeaf,
	resolvePad,
	type Container,
	type LayoutNode,
	type Leaf,
	type Library,
	type MonitorLayout,
	type Rect
} from './layoutTree';
import { findNode, findParent, updateNode } from './layoutEdit';
import { intrinsicSize, resolveGroup } from './solve';

export type Arrangement = 'row' | 'column' | 'space-horizontal' | 'space-vertical' | 'fit';
export type ArrangementPlan = {
	monitor?: MonitorLayout;
	before: Rect[];
	after: Rect[];
	message?: string;
};
const GAP = 8;
const rectFor = (
	node: LayoutNode,
	library: Library | undefined,
	measured: ReadonlyMap<string, Rect>
): Rect => {
	const known = measured.get(node.id);
	if (known) return known;
	if (isLeaf(node) && !isGroup(node.unit)) return node.unit.rect;
	const size = intrinsicSize(node, library);
	const config = isLeaf(node) && isGroup(node.unit) ? node.unit.config : undefined;
	return {
		x: typeof config?.x === 'number' ? config.x : 0,
		y: typeof config?.y === 'number' ? config.y : 0,
		...size
	};
};
const natural = (node: LayoutNode, library?: Library) =>
	intrinsicSize(isContainer(node) ? { ...node, bounds: undefined } : node, library);
const place = (node: Leaf, rect: Rect): Leaf => ({
	...node,
	basis: 'auto',
	unit: isGroup(node.unit)
		? { ...node.unit, config: { ...node.unit.config, ...rect } }
		: { ...node.unit, rect }
});

/** A reviewable immutable proposal. Applying it is a separate editor commit. */
export function planArrangement(
	monitor: MonitorLayout,
	ids: readonly string[],
	mode: Arrangement,
	library?: Library,
	measured: ReadonlyMap<string, Rect> = new Map(),
	wrapperId = 'arranged-selection'
): ArrangementPlan {
	const selected = new Set(ids);
	const nodes = [
		...monitor.floating.filter((node) => selected.has(node.id)),
		...[...selected]
			.map((id) => findNode(monitor.root, id))
			.filter((node): node is LayoutNode => node !== null)
	];
	const empty = (message: string): ArrangementPlan => ({ before: [], after: [], message });
	if (!nodes.length) return empty('Select a widget or container to arrange.');
	const before = nodes.map((node) => rectFor(node, library, measured));
	if (mode === 'fit') {
		let root = monitor.root;
		let floating = monitor.floating;
		const after: Rect[] = [];
		for (const node of nodes) {
			const previous = rectFor(
				node,
				library,
				monitor.floating.some((item) => item.id === node.id) ? new Map() : measured
			);
			let fitted: LayoutNode;
			if (isContainer(node)) {
				const size = natural(node, library);
				const bounds = { ...previous, w: Math.max(1, size.w), h: Math.max(1, size.h) };
				fitted = { ...node, bounds, basis: 'auto' };
				after.push(bounds);
			} else {
				const source = isGroup(node.unit) ? resolveGroup(node.unit, library).child : node;
				const size = isGroup(node.unit)
					? natural(source, library)
					: (measured.get(node.id) ?? natural(source, library));
				const rect = { ...previous, w: Math.max(1, size.w), h: Math.max(1, size.h) };
				fitted = { ...place(node, rect), basis: 'content' };
				after.push(rect);
			}
			if (floating.some((item) => item.id === node.id))
				floating = floating.map((item) => (item.id === node.id ? (fitted as Leaf) : item));
			else root = updateNode(root, node.id, () => fitted);
		}
		return { monitor: { ...monitor, root, floating }, before, after };
	}
	const horizontal = mode === 'row' || mode === 'space-horizontal';
	const spacing = mode.startsWith('space-');
	const singleContainer = nodes.length === 1 && isContainer(nodes[0]) ? nodes[0] : null;
	const children = singleContainer ? singleContainer.children : nodes;
	if (children.length < 2)
		return empty('Select at least two items, or a container with two items.');
	if (!singleContainer) {
		const parent = findParent(monitor.root, nodes[0].id);
		if (parent) children.sort((a, b) => parent.children.indexOf(a) - parent.children.indexOf(b));
	}
	const beforeBoxes = children.map((node) => rectFor(node, library, measured));
	const floats = monitor.floating.filter((node) => selected.has(node.id));
	const boxes =
		floats.length === nodes.length
			? beforeBoxes
			: children.map((node, index) => ({ ...beforeBoxes[index], ...intrinsicSize(node, library) }));
	const parentBox = singleContainer ? measured.get(singleContainer.id) : undefined;
	const pad = singleContainer ? resolvePad(singleContainer.pad) : { t: 0, r: 0, b: 0, l: 0 };
	const x = parentBox ? parentBox.x + pad.l : Math.min(...beforeBoxes.map((rect) => rect.x));
	const y = parentBox ? parentBox.y + pad.t : Math.min(...beforeBoxes.map((rect) => rect.y));
	const span = parentBox
		? horizontal
			? parentBox.w - pad.l - pad.r
			: parentBox.h - pad.t - pad.b
		: horizontal
			? Math.max(...beforeBoxes.map((rect) => rect.x + rect.w)) - x
			: Math.max(...beforeBoxes.map((rect) => rect.y + rect.h)) - y;
	const used = boxes.reduce((total, rect) => total + (horizontal ? rect.w : rect.h), 0);
	const gap = spacing ? Math.max(0, (span - used) / (children.length - 1)) : GAP;
	let cursor = horizontal ? x : y;
	const after = boxes.map((rect) => ({ ...rect }));
	const order = boxes.map((_, index) => index);
	const distributeFloating = spacing && floats.length === nodes.length;
	if (distributeFloating)
		order.sort((a, b) => (horizontal ? boxes[a].x - boxes[b].x : boxes[a].y - boxes[b].y));
	for (const index of order) {
		const rect = boxes[index];
		after[index] = distributeFloating
			? { ...rect, ...(horizontal ? { x: cursor } : { y: cursor }) }
			: { ...rect, x: horizontal ? cursor : x, y: horizontal ? y : cursor };
		cursor += (horizontal ? rect.w : rect.h) + gap;
	}

	if (floats.length === nodes.length) {
		const changed = new Map(children.map((node, index) => [node.id, after[index]]));
		return {
			before: beforeBoxes,
			after,
			monitor: {
				...monitor,
				floating: monitor.floating.map((node) =>
					changed.has(node.id) ? place(node, changed.get(node.id)!) : node
				)
			}
		};
	}
	if (floats.length) return empty('Arrange floating items and items in the layout separately.');
	const parent = singleContainer ?? findParent(monitor.root, nodes[0].id);
	if (
		!parent ||
		(!singleContainer && nodes.some((node) => findParent(monitor.root, node.id)?.id !== parent.id))
	)
		return empty('Select items in the same container, or select their container.');
	const picked = singleContainer
		? parent.children
		: parent.children.filter((node) => selected.has(node.id));
	const row: Container = {
		...(singleContainer ? parent : {}),
		id: singleContainer ? parent.id : wrapperId,
		kind: horizontal ? 'row' : 'col',
		children: picked.map((node) => ({ ...node, basis: 'auto' })),
		gap: spacing ? 0 : GAP,
		align: 'start',
		justify: spacing ? 'between' : 'start',
		overlap: false,
		...(spacing && !singleContainer
			? {
					bounds: {
						x: 0,
						y: 0,
						w: Math.max(...after.map((rect) => rect.x + rect.w)) - x,
						h: Math.max(...after.map((rect) => rect.y + rect.h)) - y
					}
				}
			: {})
	};
	const root = singleContainer
		? updateNode(monitor.root, parent.id, () => row)
		: updateNode(monitor.root, parent.id, () => {
				const first = parent.children.findIndex((node) => selected.has(node.id));
				return {
					...parent,
					children: parent.children.flatMap((node, index) =>
						index === first ? [row] : selected.has(node.id) ? [] : [node]
					)
				};
			});
	return { before: beforeBoxes, after, monitor: { ...monitor, root } };
}
