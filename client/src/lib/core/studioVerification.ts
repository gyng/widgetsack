import {
	isContainer,
	isGroup,
	type LayoutNode,
	type Library,
	type MonitorLayout,
	type Rect
} from './layoutTree';
import { resolveGroup } from './solve';

export type StudioMeasurement = {
	rect: Rect;
	hidden?: boolean;
	overflow?: boolean;
	error?: string;
};
export type StudioVerification = {
	ok: boolean;
	measured: boolean;
	checked: number;
	issues: { id: string; severity: 'error' | 'warning'; code: string; message: string }[];
	visualReviewRequired: true;
};
/** Check actual rendered boxes against the authored tree, including namespaced group descendants. */
export function verifyStudioLayout(
	monitor: MonitorLayout,
	library: Library | undefined,
	bounds: Rect,
	measurements: Record<string, StudioMeasurement>,
	types: string[]
): StudioVerification {
	const report: StudioVerification = {
		ok: true,
		measured: bounds.w > 0 && bounds.h > 0,
		checked: 0,
		issues: [],
		visualReviewRequired: true
	};
	const seen = new Set<string>();
	const issue = (
		id: string,
		code: string,
		message: string,
		severity: 'error' | 'warning' = 'error'
	) => report.issues.push({ id, code, message, severity });
	if (!report.measured) {
		issue(monitor.root.id, 'unavailable', 'The editor has no measurable work area.');
		report.ok = false;
		return report;
	}
	const walk = (node: LayoutNode, prefix: string, depth: number) => {
		const id = prefix + node.id;
		if (depth > 32) {
			issue(id, 'nesting', 'Group nesting exceeds the verification limit.');
			return;
		}
		if (seen.has(id)) {
			issue(id, 'duplicate', 'Duplicate rendered identity.');
			return;
		}
		seen.add(id);
		const empty = isContainer(node) && node.children.length === 0;
		const measured = measurements[id];
		if (!empty) {
			report.checked++;
			if (!measured) issue(id, 'missing', 'The layout node is absent from the rendered editor.');
			else {
				const r = measured.rect;
				if (![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.w <= 0 || r.h <= 0)
					issue(id, 'collapsed', 'The rendered box has no usable size.');
				if (
					r.x < bounds.x - 0.5 ||
					r.y < bounds.y - 0.5 ||
					r.x + r.w > bounds.x + bounds.w + 0.5 ||
					r.y + r.h > bounds.y + bounds.h + 0.5
				)
					issue(id, 'outside', 'The rendered box extends beyond the work area.', 'warning');
				if (measured.hidden)
					issue(id, 'hidden', 'The node is hidden by its rendered style.', 'warning');
				if (measured.overflow)
					issue(id, 'overflow', 'Content is clipped or scrolls; inspect it visually.', 'warning');
				if (measured.error) issue(id, 'render-error', measured.error);
			}
		}
		if (isContainer(node)) node.children.forEach((child) => walk(child, prefix, depth));
		else if (isGroup(node.unit)) {
			const defId = node.unit.def;
			if (defId && !library?.defs.some((def) => def.id === defId))
				issue(id, 'definition', 'The referenced custom widget definition is missing.');
			walk(resolveGroup(node.unit, library).child, id + '/', depth + 1);
		} else if (!types.includes(node.unit.type))
			issue(id, 'type', `Unknown widget type: ${node.unit.type}`);
	};
	walk(monitor.root, '', 0);
	monitor.floating.forEach((node) => walk(node, '', 0));
	report.ok = report.issues.every((item) => item.severity !== 'error');
	return report;
}
