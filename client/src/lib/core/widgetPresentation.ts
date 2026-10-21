import { getMeta } from './widget';
import { isContainer, isGroup, type LayoutNode, type WidgetInstance } from './layoutTree';

export type Presentation = 'minimal' | 'compact' | 'detailed';
export const PRESENTATIONS: { id: Presentation; name: string; description: string }[] = [
	{ id: 'minimal', name: 'Minimal', description: 'Essential readings, fewer labels' },
	{ id: 'compact', name: 'Compact', description: 'Key readings with small charts' },
	{ id: 'detailed', name: 'Detailed', description: 'Labels, charts and additional readings' }
];
export function isPresentation(value: unknown): value is Presentation {
	return value === 'minimal' || value === 'compact' || value === 'detailed';
}
const DETAILS = new Set(['showHeader', 'showStats', 'showDetails', 'showLegend', 'showSecondary']);
const CHARTS = new Set([
	'showSparkline',
	'showSparklines',
	'showGraph',
	'showChart',
	'showLabels',
	'showLabel',
	'axis'
]);
/** Only registered display controls change; provider credentials, sources and commands are preserved. */
export function presentationConfig(
	widget: WidgetInstance,
	mode: Presentation
): Record<string, unknown> {
	const config = { ...widget.config };
	const fields = getMeta(widget.type)?.configFields ?? [];
	for (const field of fields) {
		if (field.kind === 'toggle' && DETAILS.has(field.key)) config[field.key] = mode === 'detailed';
		if (field.kind === 'toggle' && CHARTS.has(field.key)) config[field.key] = mode !== 'minimal';
		if (field.key === 'layout' && field.kind === 'select' && field.options.includes(mode))
			config.layout = mode;
	}
	if (widget.type === 'clock') {
		const format =
			typeof config.format === 'string' ? config.format.replace(/^ddd D MMM · /, '') : 'HH:mm';
		if (/^[Hh]{1,2}:mm(?::ss)?(?: [Aa])?$/.test(format)) {
			const short = format.replace(':ss', '');
			const seconds = short.replace(':mm', ':mm:ss');
			config.format =
				mode === 'minimal' ? short : mode === 'compact' ? seconds : `ddd D MMM · ${seconds}`;
		}
	}
	return config;
}
/** Groups carry a placement override; resolveGroup applies it to a fresh resolved tree at render time. */
export function applyPresentation(node: LayoutNode, mode: Presentation): LayoutNode {
	if (isContainer(node))
		return { ...node, children: node.children.map((child) => applyPresentation(child, mode)) };
	const unit = node.unit;
	return {
		...node,
		unit: isGroup(unit)
			? {
					...unit,
					config: { ...unit.config, presentation: mode },
					tokens: { ...unit.tokens, '--np-presentation-mode': mode }
				}
			: {
					...unit,
					config: presentationConfig(unit, mode),
					tokens: { ...unit.tokens, '--np-presentation-mode': mode }
				}
	};
}
