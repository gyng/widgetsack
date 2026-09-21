// Clamp a context menu's top-left so the menu box stays fully inside the viewport. The menu opens
// at the cursor (x,y); if it would overflow the right / bottom edge we shift it back toward the
// cursor (so it effectively flips to the left of / above the pointer), keeping a small margin from
// each edge. A menu larger than the viewport pins to the top-left margin. Pure — unit-tested.
export function clampMenuToViewport(
	x: number,
	y: number,
	w: number,
	h: number,
	vw: number,
	vh: number,
	margin = 4
): { left: number; top: number } {
	let left = x;
	let top = y;
	if (left + w > vw - margin) left = Math.max(margin, vw - margin - w);
	if (top + h > vh - margin) top = Math.max(margin, vh - margin - h);
	return { left, top };
}

/**
 * Where to open a context menu for a `contextmenu` event. A mouse right-click carries its pointer
 * position; a KEYBOARD-initiated one (the Menu key / Shift+F10) arrives with `button !== 2` and
 * clientX/Y both 0 in Chromium, which used to pin the menu to the window's top-left corner far from
 * the item it acts on — for those, anchor at the target element's bounding box instead (its
 * horizontal centre, just inside the top so the box stays visible under the menu). Pure.
 */
export function contextMenuAnchor(
	e: { clientX: number; clientY: number; button: number },
	target: { left: number; top: number; width: number; height: number }
): { x: number; y: number } {
	const keyboard = e.button !== 2 || (e.clientX === 0 && e.clientY === 0);
	if (!keyboard) return { x: e.clientX, y: e.clientY };
	return {
		x: Math.round(target.left + target.width / 2),
		y: Math.round(target.top + Math.min(target.height / 2, 16))
	};
}
