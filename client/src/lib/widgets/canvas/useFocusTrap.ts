// A small focus trap for the studio's modal dialogs (the theme editor): while `active`, Tab and
// Shift+Tab cycle within the dialog's focusable elements instead of escaping into the rails behind
// it. `trapTabTarget` is the pure roving rule (unit-tested); the hook wires it to a keydown.
import { useCallback, type RefObject } from 'react';

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
	'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * Where a Tab press moves focus inside a dialog of `count` focusable items whose active index is
 * `active` (-1 when focus is outside them): the wrapped next/previous index at the edges, or null
 * when the browser's own order is fine (a Tab strictly inside the sequence).
 */
export function trapTabTarget(shift: boolean, count: number, active: number): number | null {
	if (count === 0) return null;
	if (!shift && (active === count - 1 || active === -1)) return 0;
	if (shift && (active === 0 || active === -1)) return count - 1;
	return null;
}

export function useFocusTrap(
	ref: RefObject<HTMLElement | null>,
	active: boolean
): { onKeyDown: (e: React.KeyboardEvent) => void } {
	const onKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (!active || e.key !== 'Tab') return;
			const el = ref.current;
			if (!el) return;
			const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
			const target = trapTabTarget(
				e.shiftKey,
				items.length,
				items.indexOf(document.activeElement as HTMLElement)
			);
			if (target === null) return;
			e.preventDefault();
			items[target].focus();
		},
		[ref, active]
	);
	return { onKeyDown };
}
