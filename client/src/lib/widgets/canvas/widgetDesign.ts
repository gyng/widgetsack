import { applyPresentation, type Presentation } from '../../core/widgetPresentation';
import { isContainer, type Leaf, type LayoutNode } from '../../core/layoutTree';
import type { Tokens } from '../../core/tokens';
import type { EditorState } from './types';
import type { Patch } from './editorOps';

/** Design choices are placement overrides; reusable definitions and integration setup stay intact. */
export function applyWidgetDesign(
	state: EditorState,
	ids: readonly string[] | null,
	presentation: Presentation,
	tokens: Tokens
): Patch {
	const selected = ids ? new Set(ids) : null;
	const walk = (node: LayoutNode, inside = false): LayoutNode => {
		const applies = inside || selected === null || selected.has(node.id);
		if (isContainer(node))
			return { ...node, children: node.children.map((child) => walk(child, applies)) };
		if (!applies) return node;
		const changed = applyPresentation(node, presentation) as Leaf;
		return {
			...changed,
			unit: {
				...changed.unit,
				tokens: {
					...changed.unit.tokens,
					...(selected ? tokens : {}),
					'--np-presentation-mode': presentation
				}
			}
		};
	};
	return {
		monitor: {
			...state.monitor,
			root: walk(state.monitor.root) as typeof state.monitor.root,
			floating: state.monitor.floating.map((node) => walk(node) as typeof node)
		},
		...(!selected ? { tokenOverrides: { ...tokens, '--np-presentation-mode': presentation } } : {})
	};
}
