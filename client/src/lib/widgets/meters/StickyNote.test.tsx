import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
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
});
