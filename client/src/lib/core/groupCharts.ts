import { isContainer, isGroup, type Group, type LayoutNode, type Library } from './layoutTree';
import { resolveGroup } from './solve';

function visitCharts(group: Group, library?: Library, smooth?: boolean) {
	let count = 0;
	let enabled = 0;
	const visitGroup = (unit: Group): Group => {
		const resolved = resolveGroup(unit, library);
		const child = visit(resolved.child);
		if (child === resolved.child) return unit;
		const def = library?.defs.find((def) => def.id === unit.def);
		const changed: Group = {
			...unit,
			child,
			size: resolved.size,
			name: unit.name ?? def?.name,
			css: [def?.css, unit.css].filter(Boolean).join('\n')
		};
		delete changed.def;
		delete changed.params;
		return changed;
	};
	const visit = (node: LayoutNode): LayoutNode => {
		if (isContainer(node)) {
			const children = node.children.map((child) => visit(child));
			return children.some((child, i) => child !== node.children[i]) ? { ...node, children } : node;
		}
		if (isGroup(node.unit)) {
			const unit = visitGroup(node.unit);
			return unit === node.unit ? node : { ...node, unit };
		}
		if (!['cpu', 'sparkline', 'history'].includes(node.unit.type)) return node;
		count++;
		const current = node.unit.config.smooth === true;
		if (current) enabled++;
		return smooth === undefined || smooth === current
			? node
			: { ...node, unit: { ...node.unit, config: { ...node.unit.config, smooth } } };
	};
	const changed = visitGroup(group);
	return {
		group: changed,
		count,
		value:
			enabled === 0 ? ('off' as const) : enabled === count ? ('on' as const) : ('mixed' as const)
	};
}
export function groupChartState(group: Group, library?: Library) {
	const { count, value } = visitCharts(group, library);
	return { count, value };
}
/** Apply display smoothing to just this group. Linked definitions and other instances stay intact. */
export function setGroupChartsSmooth(group: Group, smooth: boolean, library?: Library): Group {
	return visitCharts(group, library, smooth).group;
}
