import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useOverlayFocus, type UseOverlayFocusArgs } from './useOverlayFocus';

describe('useOverlayFocus', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	function mount(overrides: Partial<UseOverlayFocusArgs> = {}) {
		const apply = vi.fn();
		const hook = renderHook((props: UseOverlayFocusArgs) => useOverlayFocus(props), {
			initialProps: { enabled: true, editMode: false, windowed: false, apply, ...overrides }
		});
		return { apply, ...hook };
	}
	function field(html: string): HTMLElement {
		const host = document.createElement('div');
		host.innerHTML = html;
		document.body.appendChild(host);
		return host.firstElementChild as HTMLElement;
	}
	const press = (el: HTMLElement) =>
		act(() => {
			el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		});
	const focusOut = (from: HTMLElement, to: EventTarget | null) =>
		act(() => {
			from.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: to }));
		});

	it('makes a passive overlay non-activating on mount', () => {
		const { apply } = mount();
		expect(apply).toHaveBeenLastCalledWith(false, false);
	});

	it('pressing a button leaves the overlay non-activating (no focus steal)', () => {
		const { apply } = mount();
		press(field('<button>play</button>'));
		expect(apply).toHaveBeenCalledTimes(1);
	});

	it('pressing a text entry activates the overlay, and focus leaving it restores the policy', () => {
		const { apply } = mount();
		const input = field('<input type="text" />');
		press(input);
		expect(apply).toHaveBeenLastCalledWith(true, true);
		// Moving between text entries keeps it focusable (no flicker back to non-activating).
		const note = field('<textarea></textarea>');
		focusOut(input, note);
		expect(apply).toHaveBeenCalledTimes(2);
		focusOut(note, null);
		expect(apply).toHaveBeenLastCalledWith(false, false);
	});

	it('the window losing focus restores the policy', () => {
		const { apply } = mount();
		press(field('<textarea></textarea>'));
		act(() => {
			window.dispatchEvent(new Event('blur'));
		});
		expect(apply).toHaveBeenLastCalledWith(false, false);
	});

	it('edit mode keeps the overlay focusable without forcing activation; exiting restores it', () => {
		const { apply, rerender } = mount();
		rerender({ enabled: true, editMode: true, windowed: false, apply });
		expect(apply).toHaveBeenLastCalledWith(true, false);
		rerender({ enabled: true, editMode: false, windowed: false, apply });
		expect(apply).toHaveBeenLastCalledWith(false, false);
	});

	it('the studio never applies the policy or listens', () => {
		const { apply } = mount({ enabled: false });
		press(field('<input />'));
		expect(apply).not.toHaveBeenCalled();
	});

	it('unmounting removes the listeners', () => {
		const { apply, unmount } = mount();
		unmount();
		press(field('<input />'));
		expect(apply).toHaveBeenCalledTimes(1);
	});
});
