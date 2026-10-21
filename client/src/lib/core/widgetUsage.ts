import {
	isContainer,
	isGroup,
	type LayoutNode,
	type Library,
	type MonitorLayout
} from './layoutTree';
import { resolveGroup } from './solve';

/** Each rendered occurrence counts once; inline fallback trees of resolved definitions do not. */
export function definitionUsage(
	defId: string,
	layouts: Record<string, MonitorLayout>,
	library?: Library
): { key: string; count: number }[] {
	const result: { key: string; count: number }[] = [];
	for (const [key, monitor] of Object.entries(layouts)) {
		let count = 0;
		const visit = (node: LayoutNode) => {
			if (isContainer(node)) node.children.forEach(visit);
			else if (isGroup(node.unit)) {
				if (node.unit.def === defId) count++;
				const resolved = resolveGroup(node.unit, library);
				visit(resolved.child);
			}
		};
		visit(monitor.root);
		monitor.floating.forEach(visit);
		if (count) result.push({ key, count });
	}
	return result;
}
