import type { Rect } from './layout';
import { isContainer, type MonitorLayout } from './layoutTree';
import { flowLeaves, findParent, findNode, type Drop } from './layoutEdit';
import { gridCellRects } from './solve';

export function dropBarAt(
	mon: MonitorLayout,
	sol: ReadonlyMap<string, Rect>,
	p: { x: number; y: number },
	dragging: string
): Rect | null {
	for (const lf of flowLeaves(mon.root)) {
		if (lf.id === dragging) continue;
		const r = sol.get(lf.id);
		if (!r) continue;
		if (p.x < r.x || p.x >= r.x + r.w || p.y < r.y || p.y >= r.y + r.h) continue;
		const parent = findParent(mon.root, lf.id);
		if (!parent) continue;
		if (parent.kind === 'col') {
			const after = p.y >= r.y + r.h / 2;
			return { x: r.x, y: (after ? r.y + r.h : r.y) - 1, w: r.w, h: 2 };
		}
		const after = p.x >= r.x + r.w / 2;
		return { x: (after ? r.x + r.w : r.x) - 1, y: r.y, w: 2, h: r.h };
	}
	return null;
}

export function dropZoneAt(
	mon: MonitorLayout,
	sol: ReadonlyMap<string, Rect>,
	drop: Drop | null,
	bar: Rect | null
): Rect | null {
	if (!drop || bar) return null;
	const box = sol.get(drop.parentId);
	if (!box) return null;
	const parent = findNode(mon.root, drop.parentId);
	if (parent && isContainer(parent) && parent.kind === 'grid') {
		return gridCellRects(parent, box)[drop.index] ?? box;
	}
	return box;
}
