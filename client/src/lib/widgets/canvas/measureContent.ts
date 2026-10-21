// Browser geometry adapter: glyph bounds are only meaningful in a real layout engine.
// widgetWorkflows.spec.ts verifies that Fit to content sizes an intrinsic clock to its rendered text.
import { getMeta } from '../../core/widget';
import { findNode } from '../../core/layoutEdit';
import { isLeaf, isGroup, type MonitorLayout, type Rect } from '../../core/layoutTree';

export function measureContent(
	monitor: MonitorLayout,
	ids: readonly string[],
	current: ReadonlyMap<string, Rect>
): Map<string, Rect> {
	const result = new Map<string, Rect>();
	for (const id of ids) {
		const node = findNode(monitor.root, id) ?? monitor.floating.find((item) => item.id === id);
		if (!node || !isLeaf(node) || isGroup(node.unit) || !getMeta(node.unit.type)?.intrinsic)
			continue;
		const element = document.querySelector<HTMLElement>(
			`.canvas .world [data-w="${CSS.escape(id)}"]`
		);
		const box = current.get(id);
		if (!element || !box || box.w <= 0) continue;
		const scale = element.getBoundingClientRect().width / box.w;
		if (scale <= 0) continue;
		const parts = [...element.querySelectorAll('[data-part="value"], [data-part="label"]')];
		const rects = parts
			.map((part) => {
				const range = document.createRange();
				range.selectNodeContents(part);
				return range.getBoundingClientRect();
			})
			.filter((rect) => rect.width > 0 && rect.height > 0);
		if (!rects.length) continue;
		const left = Math.min(...rects.map((rect) => rect.left));
		const top = Math.min(...rects.map((rect) => rect.top));
		const right = Math.max(...rects.map((rect) => rect.right));
		const bottom = Math.max(...rects.map((rect) => rect.bottom));
		result.set(id, {
			...box,
			w: Math.ceil((right - left) / scale) + 2,
			h: Math.ceil((bottom - top) / scale) + 2
		});
	}
	return result;
}
