import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChecklistHost from './ChecklistHost';
beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
const add = (text: string) => {
	fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
	fireEvent.submit(screen.getByRole('textbox').closest('form')!);
};
describe('checklist persistence', () => {
	it('retains a legacy shared checklist while new dashboard copies acquire independent storage', () => {
		localStorage.setItem(
			'checklist:child',
			'[{"id":"legacy","text":"Existing task","done":false}]'
		);
		render(<ChecklistHost widgetId="child" widgetInstanceId="copy/child" />);
		expect(screen.getByText('Existing task')).toBeVisible();
		fireEvent.click(screen.getByRole('button', { name: 'Remove Existing task' }));
		cleanup();
		render(<ChecklistHost widgetId="child" widgetInstanceId="copy/child" />);
		expect(screen.queryByText('Existing task')).toBeNull();
		expect(localStorage.getItem('checklist:child')).toContain('Existing task');
	});
	it('adds, toggles, deletes, and restores tasks without mixing widget IDs', () => {
		const { rerender } = render(<ChecklistHost widgetId="one" />);
		add('Read');
		add('Write');
		fireEvent.click(screen.getByRole('checkbox', { name: 'Read' }));
		expect(JSON.parse(localStorage.getItem('checklist:one')!)).toEqual([
			expect.objectContaining({ text: 'Read', done: true }),
			expect.objectContaining({ text: 'Write', done: false })
		]);
		fireEvent.click(screen.getByRole('button', { name: 'Remove Read' }));
		expect(screen.queryByText('Read')).toBeNull();
		rerender(<ChecklistHost widgetId="two" />);
		expect(screen.queryByText('Write')).toBeNull();
		rerender(<ChecklistHost widgetId="one" />);
		expect(screen.getByText('Write')).toBeVisible();
		act(() => {
			localStorage.setItem('checklist:one', '[{"id":"remote","text":"Remote","done":false}]');
			window.dispatchEvent(new StorageEvent('storage', { key: 'checklist:one' }));
		});
		expect(screen.getByText('Remote')).toBeVisible();
		act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'other' })));
		expect(screen.getByText('Remote')).toBeVisible();
		act(() => {
			localStorage.clear();
			window.dispatchEvent(new StorageEvent('storage', { key: null }));
		});
		expect(screen.queryByText('Remote')).toBeNull();
	});
	it('prevents empty tasks and edits while arranging, and exposes save failure', () => {
		const { rerender } = render(<ChecklistHost />);
		add(' ');
		expect(screen.queryAllByRole('checkbox')).toEqual([]);
		rerender(<ChecklistHost editMode />);
		add('Blocked');
		expect(screen.queryAllByRole('checkbox')).toEqual([]);
		rerender(<ChecklistHost />);
		rerender(<ChecklistHost previewMode />);
		add('Preview');
		expect(screen.queryAllByRole('checkbox')).toEqual([]);
		rerender(<ChecklistHost />);
		vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
			throw new Error('quota');
		});
		add('Unsaved');
		expect(screen.getByRole('alert')).toHaveTextContent('could not be saved');
	});
	it('recovers when storage cannot be read', () => {
		vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
			throw new Error('denied');
		});
		render(<ChecklistHost />);
		expect(screen.getByText('Today · 0/0')).toBeVisible();
	});
});
