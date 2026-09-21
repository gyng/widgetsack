// ARIA-menu keyboard + focus management, shared by the stage context menu and the header ≡ menu
// (parametrised by the menu's element ref). `menuKeyTarget` is the pure roving-focus rule; the hook
// tags the rendered buttons as menuitems, moves focus into the menu on open, and restores focus to
// wherever it was when the menu closes. Unit-tested in useMenuFocus.test.ts.
import { useCallback, useEffect, useRef, type RefObject } from 'react';

/**
 * Where a key press moves focus within a menu of `count` items whose active index is `active`
 * (-1 when focus is outside the items): the next index (wrapping), 'close' for Escape/Tab, or null
 * for a key the menu doesn't handle (so the event propagates normally).
 */
export function menuKeyTarget(key: string, count: number, active: number): number | 'close' | null {
	if (key === 'Escape' || key === 'Tab') return 'close';
	if (count === 0) return null;
	switch (key) {
		case 'ArrowDown':
			return (active + 1 + count) % count;
		case 'ArrowUp':
			return (active - 1 + count) % count;
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
		default:
			return null;
	}
}

export type MenuFocus = {
	/** Wire to the menu element's onKeyDown: Arrow/Home/End rove, Escape/Tab close. */
	onKeyDown: (e: React.KeyboardEvent) => void;
};

/**
 * While `open`, tag the menu's buttons as menuitems (roving tabindex) and move focus to the first
 * one unless focus is already inside; on close, restore focus to the element that had it when the
 * menu opened. A re-render while open (e.g. the context menu re-pointing at a stack entry) keeps
 * focus inside without re-capturing the restore target.
 */
export function useMenuFocus(
	ref: RefObject<HTMLElement | null>,
	open: boolean,
	close: () => void
): MenuFocus {
	const restoreFocusRef = useRef<HTMLElement | null>(null);
	const wasOpenRef = useRef(false);
	useEffect(() => {
		const el = ref.current;
		if (open && el) {
			if (!wasOpenRef.current) restoreFocusRef.current = document.activeElement as HTMLElement;
			wasOpenRef.current = true;
			const items = Array.from(el.querySelectorAll<HTMLButtonElement>('button'));
			items.forEach((b) => {
				b.setAttribute('role', 'menuitem');
				b.tabIndex = -1;
			});
			if (!el.contains(document.activeElement)) items[0]?.focus();
		} else if (!open && wasOpenRef.current) {
			wasOpenRef.current = false;
			restoreFocusRef.current?.focus?.();
			restoreFocusRef.current = null;
		}
	});

	const onKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			const el = ref.current;
			if (!el) return;
			const items = Array.from(el.querySelectorAll<HTMLButtonElement>('button'));
			const target = menuKeyTarget(
				e.key,
				items.length,
				items.indexOf(document.activeElement as HTMLButtonElement)
			);
			if (target === null) return;
			e.preventDefault();
			if (target === 'close') close();
			else items[target].focus();
		},
		[ref, close]
	);

	return { onKeyDown };
}
