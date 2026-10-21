import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';

// copyToClipboard is a Tauri/clipboard adapter (outer ring) — mock it so the "Copy widget reference"
// button can be exercised without a backend. The outcome shows inline (no alert()).
vi.mock('../overlay', () => ({ copyToClipboard: vi.fn(() => Promise.resolve(true)) }));
vi.mock('./WidgetPreview', () => ({ default: () => <span>Sample meter</span> }));

import DesignerListPanel from './DesignerListPanel';
import { copyToClipboard } from '../overlay';
import { registerTemplates, unregisterTemplates, TEMPLATES } from '../core/templates';
import type { Library } from '../core/layoutTree';
import type { DefEditor } from './canvas/useDefEditor';

// The grouped def-edit actions (useDefEditor) — every entry is a spy so we can assert which one a
// click/row dispatches. Only the subset DesignerListPanel uses is required.
function makeActions(): Pick<
	DefEditor,
	| 'startNewWidget'
	| 'openExistingDef'
	| 'renameWidget'
	| 'cloneDefToEdit'
	| 'deleteWidget'
	| 'previewTemplate'
	| 'newFromTemplate'
> {
	return {
		startNewWidget: vi.fn(),
		openExistingDef: vi.fn(),
		renameWidget: vi.fn(),
		cloneDefToEdit: vi.fn(),
		deleteWidget: vi.fn(),
		previewTemplate: vi.fn(),
		newFromTemplate: vi.fn()
	};
}

const library = (): Library => ({
	version: 1,
	defs: [
		{
			id: 'def-a',
			name: 'My Gauge',
			size: { w: 100, h: 40 },
			child: { id: 'x', kind: 'col', children: [] }
		},
		{
			id: 'def-b',
			name: 'My Clock',
			size: { w: 100, h: 40 },
			child: { id: 'y', kind: 'col', children: [] }
		}
	]
});

const baseProps = () => ({
	library: library(),
	editingDefId: null as string | null,
	previewName: null as string | null,
	designing: false,
	actions: makeActions()
});

it('uses sample tooltips for Custom templates and dismisses hover previews with Escape', () => {
	vi.useFakeTimers();
	try {
		const props = baseProps();
		const view = render(<DesignerListPanel {...props} />);
		const button = view.getByRole('button', { name: 'Network' });
		fireEvent.mouseEnter(button);
		act(() => vi.advanceTimersByTime(300));
		expect(view.getByRole('tooltip')).toHaveTextContent('Sample meter');
		fireEvent.keyDown(window, { key: 'ArrowRight' });
		expect(view.getByRole('tooltip')).toBeVisible();
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(view.queryByRole('tooltip')).toBeNull();
		fireEvent.focus(button);
		act(() => vi.advanceTimersByTime(300));
		expect(view.getByRole('tooltip')).toBeVisible();
		fireEvent.click(button);
		expect(view.queryByRole('tooltip')).toBeNull();
		expect(props.actions.previewTemplate).toHaveBeenCalledWith('network');
	} finally {
		vi.useRealTimers();
	}
});

it('filters saved widgets and templates together without changing the edited definition', () => {
	const props = baseProps();
	const view = render(<DesignerListPanel {...props} editingDefId="def-b" />);
	const filter = view.getByRole('searchbox', { name: 'Filter custom widgets and templates' });
	fireEvent.change(filter, { target: { value: 'My Clock' } });
	expect(view.getByRole('button', { name: 'My Clock' })).toBeVisible();
	expect(view.queryByRole('button', { name: 'My Gauge' })).toBeNull();
	expect(view.getByLabelText('Custom widget name')).toHaveValue('My Clock');
	fireEvent.change(filter, { target: { value: 'no matching widget anywhere' } });
	expect(view.getByRole('status')).toHaveTextContent('No matches');
	fireEvent.change(filter, { target: { value: '' } });
	expect(view.getByRole('button', { name: 'My Gauge' })).toBeVisible();
	expect(props.actions.openExistingDef).not.toHaveBeenCalled();
});

let alertSpy: ReturnType<typeof vi.spyOn>;
let promptSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	vi.clearAllMocks();
	// Neither dialog may fire: rename is inline, the copy outcome is an inline status line.
	alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
	promptSpy = vi.spyOn(window, 'prompt').mockImplementation(() => null);
});
afterEach(() => {
	expect(alertSpy).not.toHaveBeenCalled();
	expect(promptSpy).not.toHaveBeenCalled();
	alertSpy.mockRestore();
	promptSpy.mockRestore();
});

describe('DesignerListPanel library list', () => {
	it('renders one row per library def with its name', () => {
		const { getByText } = render(<DesignerListPanel {...baseProps()} />);
		expect(getByText('My Gauge')).toBeTruthy();
		expect(getByText('My Clock')).toBeTruthy();
	});

	it('clicking a def label opens it for editing', () => {
		const props = baseProps();
		const { getByText } = render(<DesignerListPanel {...props} />);
		fireEvent.click(getByText('My Gauge'));
		expect(props.actions.openExistingDef).toHaveBeenCalledWith('def-a');
	});

	it('the per-row icons fire clone / delete for that def', () => {
		const props = baseProps();
		const { getByText } = render(<DesignerListPanel {...props} />);
		const row = within(getByText('My Gauge').closest('.dl-item')! as HTMLElement);
		fireEvent.click(row.getByTitle('Clone to a new custom widget'));
		expect(props.actions.cloneDefToEdit).toHaveBeenCalledWith('def-a');
		fireEvent.click(row.getByTitle('Delete custom widget'));
		expect(props.actions.deleteWidget).toHaveBeenCalledWith('def-a', 'My Gauge');
	});

	it('✎ turns the row name into an inline field; Enter commits the new name and closes it', () => {
		const props = baseProps();
		const { getByText, getByLabelText } = render(<DesignerListPanel {...props} />);
		const row = getByText('My Gauge').closest('.dl-item')! as HTMLElement;
		fireEvent.click(within(row).getByTitle('Rename custom widget'));
		const field = getByLabelText('Rename My Gauge') as HTMLInputElement;
		expect(field.value).toBe('My Gauge');
		expect(document.activeElement).toBe(field); // autofocused so typing starts right away
		fireEvent.change(field, { target: { value: 'Big Gauge' } });
		fireEvent.keyDown(field, { key: 'Enter' });
		fireEvent.blur(field); // Enter blurs the field, which is what commits (once)
		expect(props.actions.renameWidget).toHaveBeenCalledTimes(1);
		expect(props.actions.renameWidget).toHaveBeenCalledWith('def-a', 'Big Gauge');
		expect(within(row).queryByRole('textbox', { name: 'Rename My Gauge' })).toBeNull(); // back to the label + ✎
		expect(within(row).getByTitle('Rename custom widget')).toBeTruthy();
	});

	it('Escape cancels an inline rename without committing; an unchanged / blank name commits nothing', () => {
		const props = baseProps();
		const { getByText, getByLabelText } = render(<DesignerListPanel {...props} />);
		const row = getByText('My Clock').closest('.dl-item')! as HTMLElement;
		fireEvent.click(within(row).getByTitle('Rename custom widget'));
		const field = getByLabelText('Rename My Clock') as HTMLInputElement;
		fireEvent.change(field, { target: { value: 'Nope' } });
		fireEvent.keyDown(field, { key: 'Escape' });
		expect(props.actions.renameWidget).not.toHaveBeenCalled();
		expect(within(row).queryByRole('textbox', { name: 'Rename My Clock' })).toBeNull();
		// Blur with the name untouched → no rename op either.
		fireEvent.click(within(row).getByTitle('Rename custom widget'));
		fireEvent.blur(getByLabelText('Rename My Clock'));
		expect(props.actions.renameWidget).not.toHaveBeenCalled();
		// A blank draft never commits (the hook's no-op guard is also honoured here).
		fireEvent.click(within(row).getByTitle('Rename custom widget'));
		const again = getByLabelText('Rename My Clock') as HTMLInputElement;
		fireEvent.change(again, { target: { value: '   ' } });
		fireEvent.blur(again);
		expect(props.actions.renameWidget).not.toHaveBeenCalled();
		// Other keys pass through (no commit / cancel).
		fireEvent.click(within(row).getByTitle('Rename custom widget'));
		fireEvent.keyDown(getByLabelText('Rename My Clock'), { key: 'a' });
		expect(getByLabelText('Rename My Clock')).toBeTruthy();
	});

	it('shows the open custom widget’s name as an editable header field', () => {
		const props = baseProps();
		const { getByLabelText, queryByLabelText, rerender } = render(
			<DesignerListPanel {...props} editingDefId="def-b" />
		);
		const field = getByLabelText('Custom widget name') as HTMLInputElement;
		expect(field.value).toBe('My Clock');
		fireEvent.change(field, { target: { value: 'Wall Clock' } });
		fireEvent.blur(field);
		expect(props.actions.renameWidget).toHaveBeenCalledWith('def-b', 'Wall Clock');
		// The header field stays (it is the open widget's name, not a transient row edit).
		expect(getByLabelText('Custom widget name')).toBeTruthy();
		// No open widget → no header field.
		rerender(<DesignerListPanel {...props} editingDefId={null} />);
		expect(queryByLabelText('Custom widget name')).toBeNull();
	});

	it('marks the currently-edited def row with the "cur" class', () => {
		const { getByText } = render(<DesignerListPanel {...baseProps()} editingDefId="def-b" />);
		expect(getByText('My Clock').closest('.dl-item')!.className).toContain('cur');
		expect(getByText('My Gauge').closest('.dl-item')!.className).not.toContain('cur');
	});

	it('shows the empty-library stub when there are no defs (and no header field for an unknown open id)', () => {
		const { getByText, queryByLabelText, rerender } = render(
			<DesignerListPanel {...baseProps()} library={{ version: 1, defs: [] }} editingDefId="gone" />
		);
		expect(getByText(/No custom widgets yet/)).toBeTruthy();
		expect(getByText('My widgets')).toBeTruthy();
		expect(queryByLabelText('Custom widget name')).toBeNull();
		rerender(<DesignerListPanel {...baseProps()} library={undefined} />);
		expect(getByText(/No custom widgets yet/)).toBeVisible();
	});
});

describe('DesignerListPanel template groups', () => {
	it('renders the built-in Templates group with the preset rows', () => {
		const { getByText } = render(<DesignerListPanel {...baseProps()} />);
		expect(getByText('Templates')).toBeTruthy();
		// The built-in template names (core/templates.ts TEMPLATES).
		expect(getByText('System monitor')).toBeTruthy();
		expect(getByText('Now playing')).toBeTruthy();
	});

	it('clicking a template name previews it (read-only)', () => {
		const props = baseProps();
		const { getByText } = render(<DesignerListPanel {...props} />);
		fireEvent.click(getByText('System monitor'));
		expect(props.actions.previewTemplate).toHaveBeenCalledWith('system');
	});

	it('the template clone icon clones it into a new library widget', () => {
		const props = baseProps();
		const { getByText } = render(<DesignerListPanel {...props} />);
		const row = within(getByText('Network').closest('.dl-item')! as HTMLElement);
		fireEvent.click(row.getByRole('button', { name: 'Use Network template' }));
		expect(props.actions.newFromTemplate).toHaveBeenCalledWith('network');
	});

	it('highlights the previewed template row by name', () => {
		const { getByText } = render(<DesignerListPanel {...baseProps()} previewName="Network" />);
		expect(getByText('Network').closest('.dl-item')!.className).toContain('cur');
	});

	it('labels a plugin template group "Templates · <group>" (built-ins stay plain "Templates")', () => {
		// A plugin package contributes its own group; the built-in group keeps the unqualified header.
		registerTemplates('My Pack', [{ ...TEMPLATES[1], id: 'pack-system', name: 'Pack System' }]);
		let unmount: () => void = () => undefined;
		try {
			const view = render(<DesignerListPanel {...baseProps()} />);
			unmount = view.unmount;
			const { getByText } = view;
			expect(getByText('Templates')).toBeTruthy();
			expect(getByText('Templates · My Pack')).toBeTruthy();
			expect(getByText('Pack System')).toBeTruthy();
		} finally {
			unmount();
			unregisterTemplates('My Pack');
		}
	});
});

describe('DesignerListPanel header actions', () => {
	it('discards a clipboard result after leaving the designer', async () => {
		let finish!: (ok: boolean) => void;
		vi.mocked(copyToClipboard).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		const view = render(<DesignerListPanel {...baseProps()} />);
		fireEvent.click(view.getByRole('button', { name: 'Copy widget reference' }));
		view.unmount();
		await act(async () => finish(true));
	});
	it('the New custom widget button starts a fresh def', () => {
		const props = baseProps();
		const { getByRole } = render(<DesignerListPanel {...props} />);
		fireEvent.click(getByRole('button', { name: 'New custom widget' }));
		expect(props.actions.startNewWidget).toHaveBeenCalledTimes(1);
	});

	it('Copy widget reference copies markdown and reports success inline', async () => {
		const { getByRole, findByRole } = render(<DesignerListPanel {...baseProps()} />);
		fireEvent.click(getByRole('button', { name: 'Copy widget reference' }));
		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledTimes(1));
		// The copied payload is the generated widget-reference markdown (non-empty).
		const md = vi.mocked(copyToClipboard).mock.calls[0][0];
		expect(typeof md).toBe('string');
		expect(md.length).toBeGreaterThan(0);
		expect((await findByRole('status')).textContent).toMatch(/copied/i);
	});

	it('reports a failure inline (and does not claim success) when the copy fails', async () => {
		vi.mocked(copyToClipboard).mockResolvedValueOnce(false);
		const { getByRole, findByRole } = render(<DesignerListPanel {...baseProps()} />);
		fireEvent.click(getByRole('button', { name: 'Copy widget reference' }));
		expect((await findByRole('status')).textContent).toMatch(/Copy failed/i);
	});
});

describe('DesignerListPanel empty-state explainer', () => {
	it('shows the "Widget designer" explainer when not designing', () => {
		const { getByText } = render(<DesignerListPanel {...baseProps()} designing={false} />);
		expect(getByText('Widget designer')).toBeTruthy();
	});

	it('hides the explainer once a def/preview is open', () => {
		const { queryByText } = render(<DesignerListPanel {...baseProps()} designing />);
		expect(queryByText('Widget designer')).toBeNull();
	});
});

it('persists preview cards for saved widgets and templates while retaining actions', () => {
	localStorage.removeItem('widgetsack.designer.view');
	const props = baseProps();
	const view = render(<DesignerListPanel {...props} />);
	fireEvent.click(view.getByRole('button', { name: 'Previews' }));
	expect(localStorage.getItem('widgetsack.designer.view')).toBe('tiles');
	expect(view.container.querySelectorAll('.preview-tiles .catalog-preview').length).toBeGreaterThan(
		2
	);
	fireEvent.click(view.getByRole('button', { name: 'Duplicate My Gauge' }));
	expect(props.actions.cloneDefToEdit).toHaveBeenCalledWith('def-a');
	view.unmount();
	const restored = render(<DesignerListPanel {...props} />);
	expect(restored.getByRole('button', { name: 'Previews' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	fireEvent.click(restored.getByRole('button', { name: 'List' }));
	expect(restored.container.querySelector('.catalog-preview')).toBeNull();
	expect(localStorage.getItem('widgetsack.designer.view')).toBe('rows');
});
it('keeps the catalog usable when view preferences cannot be read or saved', () => {
	const read = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
		throw Error('blocked');
	});
	const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
		throw Error('blocked');
	});
	try {
		const view = render(<DesignerListPanel {...baseProps()} />);
		expect(view.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
		fireEvent.click(view.getByRole('button', { name: 'Previews' }));
		expect(view.getByRole('button', { name: 'Previews' })).toHaveAttribute('aria-pressed', 'true');
	} finally {
		read.mockRestore();
		write.mockRestore();
	}
});
