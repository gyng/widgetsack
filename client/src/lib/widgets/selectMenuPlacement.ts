/** Viewport-constrained popup geometry shared by listbox and searchable selects. */
export function selectMenuPlacement(
	rect: { left: number; top: number; bottom: number; width: number },
	viewport: { w: number; h: number },
	minWidth = 0
) {
	const margin = 8;
	const width = Math.min(Math.max(rect.width, minWidth), Math.max(0, viewport.w - margin * 2));
	const left = Math.max(margin, Math.min(rect.left, viewport.w - width - margin));
	const below = Math.max(0, viewport.h - rect.bottom - margin - 2);
	const above = Math.max(0, rect.top - margin - 2);
	const flip = below < 200 && above > below;
	return {
		left,
		width,
		maxHeight: Math.min(248, flip ? above : below),
		...(flip
			? { bottom: Math.max(margin, viewport.h - rect.top + 2) }
			: { top: Math.max(margin, rect.bottom + 2) })
	};
}
