// A copy-pasteable debug snapshot of the editor/solver state, for diagnosing layout problems
// (panes that vanish, solve outside the canvas, collapse to zero, etc.). PURE: it takes the live
// state in and returns a formatted string — the Canvas gathers the args, an overlay adapter does the
// clipboard write. It auto-flags every container box that is collapsed (zero-size) or escapes the
// work-area bounds, so the report points straight at the cause. Co-located tests in debugInfo.test.ts.

import { collectContainerRects, type Solved } from '../../core/solve';
import { findNode } from '../../core/layoutEdit';
import {
	isContainer,
	isGroup,
	isLeaf,
	type Container,
	type Group,
	type LayoutNode,
	type MonitorLayout,
	type Rect,
	type WidgetInstance
} from '../../core/layoutTree';

export type DebugArgs = {
	designing: boolean;
	editingDef: { id: string; name: string; size: { w: number; h: number } } | null;
	monitorKey: string;
	workArea: Rect;
	stageSize: { w: number; h: number };
	zoom: number;
	panX: number;
	panY: number;
	monitor: MonitorLayout;
	solved: Solved;
	selectedId: string | null;
	defs: { id: string; name: string; size: { w: number; h: number } }[];
};

const r0 = (n: number): number => Math.round(n * 100) / 100; // tidy floats for the report
const fmtRect = (r: Rect): string => `{x:${r0(r.x)}, y:${r0(r.y)}, w:${r0(r.w)}, h:${r0(r.h)}}`;
const padGap = (c: Container): string =>
	`pad=${JSON.stringify(c.pad ?? 0)} gap=${c.gap ?? 0} basis=${JSON.stringify(c.basis ?? 'auto')}`;

// Is `r` outside `bounds` (with a 0.5px tolerance for float seams)?
function escapesBounds(r: Rect, b: Rect): boolean {
	const e = 0.5;
	return r.x < b.x - e || r.y < b.y - e || r.x + r.w > b.x + b.w + e || r.y + r.h > b.y + b.h + e;
}

export function buildDebugInfo(a: DebugArgs): string {
	const lines: string[] = [];
	lines.push('=== WidgetSack debug ===');
	lines.push(`mode: ${a.designing ? 'widget-designer' : 'layout'}`);
	lines.push(`monitor: ${a.monitorKey}`);
	if (a.editingDef) {
		const d = a.editingDef;
		lines.push(`editing def: ${d.id} "${d.name}" size ${d.size.w}×${d.size.h}`);
	}
	lines.push(
		`stage: workArea ${fmtRect(a.workArea)} · stageSize ${a.stageSize.w}×${a.stageSize.h} · ` +
			`zoom ${Math.round(a.zoom * 100)}% · pan ${r0(a.panX)},${r0(a.panY)}`
	);

	// Selected node summary (the usual suspect for "I changed X and it broke").
	const sel = a.selectedId ? findInMonitor(a.monitor, a.selectedId) : null;
	if (sel) {
		const box = a.solved.get(a.selectedId as string);
		if (isContainer(sel)) {
			lines.push(
				`selected: ${sel.id} (${sel.kind}) box ${box ? fmtRect(box) : '—'} · ${padGap(sel)} · ` +
					`children=${sel.children.length}`
			);
		} else if (isLeaf(sel)) {
			const u = sel.unit;
			const kind = isGroup(u)
				? `group:${(u as Group).def ?? 'inline'}`
				: (u as WidgetInstance).type;
			lines.push(`selected: ${sel.id} (${kind}) box ${box ? fmtRect(box) : '—'}`);
		}
	} else {
		lines.push('selected: (none)');
	}

	// Every container's solved box, with auto-flags. This is the part that exposes vanished panes.
	lines.push('');
	lines.push('containers (solved boxes):');
	const issues: string[] = [];
	for (const c of collectContainerRects(a.monitor, a.solved)) {
		const flags: string[] = [];
		if (c.rect.w <= 0 || c.rect.h <= 0) flags.push('Warning: COLLAPSED (zero size)');
		if (escapesBounds(c.rect, a.workArea)) flags.push('Warning: OUT-OF-BOUNDS');
		const tag = flags.length ? '  ' + flags.join(' ') : '';
		lines.push(`  ${c.id} (${c.kind}) ${fmtRect(c.rect)}${tag}`);
		if (flags.length) issues.push(`${c.id} (${c.kind}): ${flags.join(', ')}`);
	}

	lines.push('');
	if (issues.length) {
		lines.push(`issues (${issues.length}):`);
		for (const i of issues) lines.push(`  ${i}`);
	} else {
		lines.push('issues: none detected');
	}

	lines.push(`floating widgets: ${a.monitor.floating.length}`);
	if (a.defs.length) {
		lines.push('');
		lines.push('library defs:');
		for (const d of a.defs) lines.push(`  ${d.id} "${d.name}" ${d.size.w}×${d.size.h}`);
	}

	lines.push('');
	lines.push('tree (monitor.root):');
	lines.push(JSON.stringify(a.monitor.root, null, 2));

	return lines.join('\n');
}

// Selected node: flow tree (findNode) then the floating layer.
function findInMonitor(mon: MonitorLayout, id: string): LayoutNode | null {
	return findNode(mon.root, id) ?? mon.floating.find((l) => l.id === id) ?? null;
}
