import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { menuKeyTarget, useMenuFocus } from './useMenuFocus';

describe('menuKeyTarget (pure roving-focus rule)', () => {
	it('Escape / Tab close regardless of the item count', () => {
		expect(menuKeyTarget('Escape', 3, 0)).toBe('close');
		expect(menuKeyTarget('Tab', 0, -1)).toBe('close');
	});

	it('arrows wrap in both directions; Home/End jump; from outside the items ArrowDown lands on the first', () => {
		expect(menuKeyTarget('ArrowDown', 3, -1)).toBe(0);
		expect(menuKeyTarget('ArrowDown', 3, 2)).toBe(0);
		expect(menuKeyTarget('ArrowUp', 3, 0)).toBe(2);
		expect(menuKeyTarget('ArrowUp', 3, -1)).toBe(1);
		expect(menuKeyTarget('Home', 3, 2)).toBe(0);
		expect(menuKeyTarget('End', 3, 0)).toBe(2);
	});

	it('is null for keys the menu does not handle, and for navigation over an empty menu', () => {
		expect(menuKeyTarget('a', 3, 0)).toBeNull();
		expect(menuKeyTarget('ArrowDown', 0, -1)).toBeNull();
	});
});

// A menu element with three buttons plus an "opener" button that held focus before it opened.
function dom() {
	const opener = document.createElement('button');
	opener.textContent = 'open';
	const menu = document.createElement('div');
	const items = ['a', 'b', 'c'].map((t) => {
		const b = document.createElement('button');
		b.textContent = t;
		menu.append(b);
		return b;
	});
	document.body.append(opener, menu);
	return { opener, menu, items };
}

const key = (k: string) =>
	({ key: k, preventDefault: vi.fn() }) as unknown as React.KeyboardEvent & {
		preventDefault: ReturnType<typeof vi.fn>;
	};

afterEach(() => {
	document.body.innerHTML = '';
});

describe('useMenuFocus', () => {
	it('on open: tags the buttons as menuitems, focuses the first; on close: restores the opener', () => {
		const { opener, menu, items } = dom();
		opener.focus();
		const close = vi.fn();
		const ref = { current: menu };
		const { rerender } = renderHook(({ open }) => useMenuFocus(ref, open, close), {
			initialProps: { open: false }
		});
		expect(document.activeElement).toBe(opener); // closed from the start: nothing happens
		rerender({ open: true });
		expect(items.every((b) => b.getAttribute('role') === 'menuitem' && b.tabIndex === -1)).toBe(
			true
		);
		expect(document.activeElement).toBe(items[0]);
		// A re-render while open (the context menu re-pointing) keeps focus where it is.
		items[1].focus();
		rerender({ open: true });
		expect(document.activeElement).toBe(items[1]);
		rerender({ open: false });
		expect(document.activeElement).toBe(opener);
	});

	it('does nothing when the ref has no element yet (menu not mounted)', () => {
		const { opener } = dom();
		opener.focus();
		const ref = { current: null };
		const { result } = renderHook(() => useMenuFocus(ref, true, vi.fn()));
		expect(document.activeElement).toBe(opener);
		act(() => result.current.onKeyDown(key('ArrowDown'))); // no element → ignored
		expect(document.activeElement).toBe(opener);
	});

	it('onKeyDown roves with Arrow/Home/End, closes on Escape, and lets other keys through', () => {
		const { menu, items } = dom();
		const close = vi.fn();
		const ref = { current: menu };
		const { result } = renderHook(() => useMenuFocus(ref, true, close));
		expect(document.activeElement).toBe(items[0]);
		act(() => result.current.onKeyDown(key('ArrowDown')));
		expect(document.activeElement).toBe(items[1]);
		act(() => result.current.onKeyDown(key('End')));
		expect(document.activeElement).toBe(items[2]);
		act(() => result.current.onKeyDown(key('ArrowDown'))); // wraps
		expect(document.activeElement).toBe(items[0]);
		const other = key('x');
		act(() => result.current.onKeyDown(other));
		expect(other.preventDefault).not.toHaveBeenCalled();
		const esc = key('Escape');
		act(() => result.current.onKeyDown(esc));
		expect(esc.preventDefault).toHaveBeenCalled();
		expect(close).toHaveBeenCalledTimes(1);
	});
});
