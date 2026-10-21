import {
	container,
	group,
	isGroup,
	leaf,
	type LayoutNode,
	type MonitorLayout,
	type Rect,
	type WidgetDef
} from '../../core/layoutTree';
import { findParent, updateNode } from '../../core/layoutEdit';
import { intrinsicSize } from '../../core/solve';
import { clone, cfgNum, type Patch } from './editorOps';
import type { EditorState } from './types';

export function canSaveSelectionWidget(monitor: MonitorLayout, ids: readonly string[]): boolean {
	const unique = [...new Set(ids)];
	if (unique.length < 2) return false;
	const floating = monitor.floating.filter((node) => unique.includes(node.id));
	if (floating.length) return floating.length === unique.length;
	const parent = findParent(monitor.root, unique[0]);
	return !!parent && unique.every((id) => findParent(monitor.root, id)?.id === parent.id);
}
/** Create a definition and replace its selected pieces together in one undoable edit. */
export function saveSelectionWidget(
	state: EditorState,
	ids: readonly string[],
	groupId: string,
	defId: string,
	measured: ReadonlyMap<string, Rect> = new Map()
): Patch {
	if (!canSaveSelectionWidget(state.monitor, ids)) return {};
	const selected = new Set(ids);
	const floating = state.monitor.floating.filter((node) => selected.has(node.id));
	let child: LayoutNode;
	let x = 0;
	let y = 0;
	let parent = null;
	if (floating.length) {
		const boxes = floating.map(
			(node) =>
				measured.get(node.id) ??
				(isGroup(node.unit)
					? {
							x: cfgNum(node.unit.config, 'x'),
							y: cfgNum(node.unit.config, 'y'),
							...intrinsicSize(node, state.library)
						}
					: node.unit.rect)
		);
		x = Math.min(...boxes.map((box) => box.x));
		y = Math.min(...boxes.map((box) => box.y));
		const w = Math.max(...boxes.map((box) => box.x + box.w)) - x;
		const h = Math.max(...boxes.map((box) => box.y + box.h)) - y;
		child = container(
			`${groupId}-content`,
			'col',
			floating.map((node, index) => {
				const copy = clone(node);
				const box = { ...boxes[index], x: boxes[index].x - x, y: boxes[index].y - y };
				copy.unit = isGroup(copy.unit)
					? { ...copy.unit, config: { ...copy.unit.config, ...box } }
					: { ...copy.unit, rect: box };
				return copy;
			}),
			{ overlap: true, bounds: { x: 0, y: 0, w, h }, align: 'start' }
		);
	} else {
		parent = findParent(state.monitor.root, ids[0])!;
		child = {
			...clone(parent),
			id: `${groupId}-content`,
			bounds: undefined,
			children: parent.children.filter((node) => selected.has(node.id)).map(clone)
		};
	}
	const natural = intrinsicSize(child, state.library);
	const size = { w: Math.max(1, natural.w), h: Math.max(1, natural.h) };
	const definition: WidgetDef = { id: defId, name: 'Custom panel', size, child };
	const placement = leaf(
		group(groupId, size, clone(child), {
			def: defId,
			name: definition.name,
			...(floating.length ? { config: { x, y } } : {})
		})
	);
	const root = parent
		? updateNode(state.monitor.root, parent.id, () => {
				const first = parent!.children.findIndex((node) => selected.has(node.id));
				return {
					...parent!,
					children: parent!.children.flatMap((node, index) =>
						index === first ? [placement] : selected.has(node.id) ? [] : [node]
					)
				};
			})
		: state.monitor.root;
	return {
		library: {
			version: state.library?.version ?? 1,
			defs: [...(state.library?.defs ?? []), definition]
		},
		monitor: {
			...state.monitor,
			root,
			floating: floating.length
				? [...state.monitor.floating.filter((node) => !selected.has(node.id)), placement]
				: state.monitor.floating
		},
		selectedId: groupId,
		selectedIds: [groupId]
	};
}
