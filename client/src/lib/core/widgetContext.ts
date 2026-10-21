import { isContainer, isGroup, type LayoutNode, type MonitorLayout } from './layoutTree';
import { getMeta } from './widget';

export type Breadcrumb = { id: string; label: string };
/** Follow authored containers only; a reusable group is one selectable unit on its desktop. */
export function selectionBreadcrumb(
	monitor: MonitorLayout,
	selectedId: string | null
): Breadcrumb[] {
	if (!selectedId) return [];
	const walk = (node: LayoutNode, path: Breadcrumb[]): Breadcrumb[] | null => {
		const label = isContainer(node)
			? { row: 'Row', col: 'Column', grid: 'Grid' }[node.kind]
			: isGroup(node.unit)
				? node.unit.name || 'Widget'
				: (getMeta(node.unit.type)?.label ?? node.unit.type);
		const next = [...path, { id: node.id, label }];
		if (node.id === selectedId) return next;
		if (isContainer(node)) {
			for (const child of node.children) {
				const found = walk(child, next);
				if (found) return found;
			}
		}
		return null;
	};
	if (selectedId === monitor.root.id) return [{ id: selectedId, label: 'Layout' }];
	const flow = walk(monitor.root, []);
	if (flow) return flow.slice(1);
	for (const leaf of monitor.floating) {
		const found = walk(leaf, []);
		if (found) return found;
	}
	return [];
}
