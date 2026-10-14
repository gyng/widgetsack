// Pure resolver for conditional-container visibility: walk the flow tree, find containers with a
// `condition`, and (given the live window list + sensor values) compute which container ids are
// currently HIDDEN. The React layer (Canvas) supplies the live ConditionContext and applies the set
// as visibility:hidden in FlowNode. Kept pure + co-located-testable; no React/Tauri.

import {
	isContainer,
	isGroup,
	type LayoutNode,
	type Library,
	type MonitorLayout
} from '../../core/layoutTree';
import { resolveGroup } from '../../core/solve';
import {
	conditionMet,
	conditionRefs,
	type Condition,
	type ConditionContext
} from '../../core/condition';
import type { WindowDescriptor } from '../../core/windowMatch';

export type ConditionalNode = { id: string; condition: Condition };

/** A stable, order-independent signature of the open-window set, over ONLY the fields conditions
 * match on (exe/className/title). Used for change-detection so window moves, z-order churn, or handle
 * changes (which appOpen ignores) don't trigger needless re-renders every poll. Pure. */
export function windowsKey(windows: readonly WindowDescriptor[]): string {
	return windows
		.map((w) => `${w.exe}|${w.className}|${w.title}`)
		.sort()
		.join('\n');
}

/** Every container in the subtree that carries a condition (depth-first, stable order). */
export function collectConditions(
	node: LayoutNode,
	library?: Library,
	prefix = ''
): ConditionalNode[] {
	const out: ConditionalNode[] = [];
	const walk = (n: LayoutNode, namespace: string): void => {
		if (isContainer(n)) {
			if (n.condition) out.push({ id: namespace + n.id, condition: n.condition });
			n.children.forEach((child) => walk(child, namespace));
		} else if (isGroup(n.unit)) {
			walk(resolveGroup(n.unit, library).child, `${namespace}${n.id}/`);
		}
	};
	walk(node, prefix);
	return out;
}

/** Conditions in both rendered layers, including effective reusable widget definitions. */
export function collectMonitorConditions(
	monitor: MonitorLayout,
	library?: Library
): ConditionalNode[] {
	return [
		...collectConditions(monitor.root, library),
		...monitor.floating.flatMap((leaf) => collectConditions(leaf, library))
	];
}

/** The de-duplicated sensor ids all the conditions depend on (what to subscribe to). */
export function conditionSensorRefs(conds: readonly ConditionalNode[]): string[] {
	const s = new Set<string>();
	for (const c of conds) for (const r of conditionRefs(c.condition)) s.add(r);
	return [...s];
}

/** The set of container ids whose condition is currently UNsatisfied (→ hide, keep space). */
export function hiddenContainerIds(
	conds: readonly ConditionalNode[],
	ctx: ConditionContext
): Set<string> {
	const hidden = new Set<string>();
	for (const c of conds) if (!conditionMet(c.condition, ctx)) hidden.add(c.id);
	return hidden;
}
