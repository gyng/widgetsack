import { afterEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { trapTabTarget, useFocusTrap } from './useFocusTrap';

describe('trapTabTarget', () => {
	it('wraps Tab from the last item (or from outside) to the first', () => {
		expect(trapTabTarget(false, 3, 2)).toBe(0);
		expect(trapTabTarget(false, 3, -1)).toBe(0);
	});
	it('wraps Shift+Tab from the first item (or from outside) to the last', () => {
		expect(trapTabTarget(true, 3, 0)).toBe(2);
		expect(trapTabTarget(true, 3, -1)).toBe(2);
	});
	it('lets the browser handle a Tab strictly inside the sequence, and an empty dialog', () => {
		expect(trapTabTarget(false, 3, 0)).toBeNull();
		expect(trapTabTarget(true, 3, 2)).toBeNull();
		expect(trapTabTarget(false, 0, -1)).toBeNull();
	});
});

describe('useFocusTrap', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	function dialog(): { el: HTMLDivElement; first: HTMLButtonElement; last: HTMLButtonElement } {
		const el = document.createElement('div');
		el.innerHTML =
			'<button id="a">a</button><input id="b" /><button id="c" disabled>c</button><button id="d">d</button>';
		document.body.appendChild(el);
		return {
			el,
			first: el.querySelector('#a') as HTMLButtonElement,
			last: el.querySelector('#d') as HTMLButtonElement
		};
	}
	const keyEvent = (key: string, shiftKey = false) => {
		let prevented = false;
		return {
			ev: {
				key,
				shiftKey,
				preventDefault: () => (prevented = true)
			} as unknown as React.KeyboardEvent,
			prevented: () => prevented
		};
	};

	it('Tab on the last focusable wraps to the first (skipping disabled controls)', () => {
		const { el, first, last } = dialog();
		const { result } = renderHook(() => useFocusTrap({ current: el }, true));
		last.focus();
		const k = keyEvent('Tab');
		result.current.onKeyDown(k.ev);
		expect(document.activeElement).toBe(first);
		expect(k.prevented()).toBe(true);
	});

	it('Shift+Tab on the first wraps to the last', () => {
		const { el, first, last } = dialog();
		const { result } = renderHook(() => useFocusTrap({ current: el }, true));
		first.focus();
		result.current.onKeyDown(keyEvent('Tab', true).ev);
		expect(document.activeElement).toBe(last);
	});

	it('leaves other keys, an inactive trap, a mid-sequence Tab, and a missing element alone', () => {
		const { el, first } = dialog();
		first.focus();
		const off = renderHook(() => useFocusTrap({ current: el }, false));
		const k1 = keyEvent('Tab');
		off.result.current.onKeyDown(k1.ev);
		expect(k1.prevented()).toBe(false);
		const on = renderHook(() => useFocusTrap({ current: el }, true));
		const k2 = keyEvent('Enter');
		on.result.current.onKeyDown(k2.ev);
		expect(k2.prevented()).toBe(false);
		const k3 = keyEvent('Tab'); // from the first of four → the browser moves to the input
		on.result.current.onKeyDown(k3.ev);
		expect(k3.prevented()).toBe(false);
		const none = renderHook(() => useFocusTrap({ current: null }, true));
		const k4 = keyEvent('Tab');
		none.result.current.onKeyDown(k4.ev);
		expect(k4.prevented()).toBe(false);
	});
});
