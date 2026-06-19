import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import StickyNote from './StickyNote';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe('StickyNote', () => {
	it('persists text to localStorage by widget id and reloads it', () => {
		const first = render(<StickyNote widgetId="w1" />);
		const ta = first.container.querySelector('textarea') as HTMLTextAreaElement;
		fireEvent.change(ta, { target: { value: 'buy milk' } });
		expect(localStorage.getItem('scratch:w1')).toBe('buy milk');
		first.unmount();

		const second = render(<StickyNote widgetId="w1" />);
		expect((second.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
			'buy milk'
		);
	});

	it('is read-only in studio edit mode (so the widget stays draggable)', () => {
		localStorage.setItem('scratch:w2', 'note');
		const { container } = render(<StickyNote widgetId="w2" editMode />);
		const ta = container.querySelector('textarea') as HTMLTextAreaElement;
		expect(ta.readOnly).toBe(true);
		expect(ta.value).toBe('note');
	});

	it('shows the placeholder when empty', () => {
		const { container } = render(<StickyNote widgetId="w3" placeholder="Type here" />);
		expect((container.querySelector('textarea') as HTMLTextAreaElement).placeholder).toBe(
			'Type here'
		);
	});

	it('syncs edits from the other window via the storage event', () => {
		const { container } = render(<StickyNote widgetId="w4" />);
		const ta = container.querySelector('textarea') as HTMLTextAreaElement;
		expect(ta.value).toBe('');
		// A matching key updates the note; a non-matching key is ignored.
		act(() => {
			window.dispatchEvent(
				new StorageEvent('storage', { key: 'scratch:w4', newValue: 'from overlay' })
			);
		});
		expect(ta.value).toBe('from overlay');
		act(() => {
			window.dispatchEvent(new StorageEvent('storage', { key: 'scratch:other', newValue: 'nope' }));
		});
		expect(ta.value).toBe('from overlay');
		// A cleared key (newValue null) resets to empty.
		act(() => {
			window.dispatchEvent(new StorageEvent('storage', { key: 'scratch:w4', newValue: null }));
		});
		expect(ta.value).toBe('');
	});

	it('does not touch localStorage when it has no widget id', () => {
		const spy = vi.spyOn(localStorage, 'setItem');
		const { container } = render(<StickyNote />);
		fireEvent.change(container.querySelector('textarea') as HTMLTextAreaElement, {
			target: { value: 'ephemeral' }
		});
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it('swallows a localStorage write failure (note just will not persist)', () => {
		const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
			throw new Error('quota');
		});
		const { container } = render(<StickyNote widgetId="w5" />);
		const ta = container.querySelector('textarea') as HTMLTextAreaElement;
		expect(() => fireEvent.change(ta, { target: { value: 'x' } })).not.toThrow();
		// The in-memory value still updates even though the write threw.
		expect(ta.value).toBe('x');
		spy.mockRestore();
	});

	it('recovers an empty string when reading localStorage throws', () => {
		const spy = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		const { container } = render(<StickyNote widgetId="w6" />);
		expect(spy).toHaveBeenCalled();
		expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
		spy.mockRestore();
	});

	it('stops pointer/wheel from bubbling on the live overlay (not edit mode)', () => {
		const { container } = render(<StickyNote widgetId="w7" />);
		const ta = container.querySelector('textarea') as HTMLTextAreaElement;
		const down = new Event('pointerdown', { bubbles: true });
		const stopDown = vi.spyOn(down, 'stopPropagation');
		ta.dispatchEvent(down);
		expect(stopDown).toHaveBeenCalled();
		const wheel = new Event('wheel', { bubbles: true });
		const stopWheel = vi.spyOn(wheel, 'stopPropagation');
		ta.dispatchEvent(wheel);
		expect(stopWheel).toHaveBeenCalled();
	});

	it('lets pointer/wheel through in edit mode (so the widget stays draggable)', () => {
		const { container } = render(<StickyNote widgetId="w8" editMode />);
		const ta = container.querySelector('textarea') as HTMLTextAreaElement;
		const down = new Event('pointerdown', { bubbles: true });
		const stopDown = vi.spyOn(down, 'stopPropagation');
		ta.dispatchEvent(down);
		expect(stopDown).not.toHaveBeenCalled();
		const wheel = new Event('wheel', { bubbles: true });
		const stopWheel = vi.spyOn(wheel, 'stopPropagation');
		ta.dispatchEvent(wheel);
		expect(stopWheel).not.toHaveBeenCalled();
	});

	it('passes a per-instance color as the --note-accent CSS variable', () => {
		const { container } = render(<StickyNote widgetId="w9" color="rgb(4, 5, 6)" />);
		const root = container.querySelector('.np-stickynote') as HTMLElement;
		expect(root.style.getPropertyValue('--note-accent')).toBe('rgb(4, 5, 6)');
	});
});
