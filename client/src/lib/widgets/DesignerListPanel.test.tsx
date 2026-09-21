import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';

// copyToClipboard is a Tauri/clipboard adapter (outer ring) — mock it so the "Copy widget reference"
// button can be exercised without a backend. The outcome shows inline (no alert()).
vi.mock('../overlay', () => ({ copyToClipboard: vi.fn(() => Promise.resolve(true)) }));

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
		const { getByText, getByLabelText, queryByLabelText } = render(
			<DesignerListPanel {...props} />
		);
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
		expect(queryByLabelText('Rename My Gauge')).toBeNull(); // back to the label + ✎
		expect(within(row).getByTitle('Rename custom widget')).toBeTruthy();
	});

	it('Escape cancels an inline rename without committing; an unchanged / blank name commits nothing', () => {
		const props = baseProps();
		const { getByText, getByLabelText, queryByLabelText } = render(
			<DesignerListPanel {...props} />
		);
		const row = getByText('My Clock').closest('.dl-item')! as HTMLElement;
		fireEvent.click(within(row).getByTitle('Rename custom widget'));
		const field = getByLabelText('Rename My Clock') as HTMLInputElement;
		fireEvent.change(field, { target: { value: 'Nope' } });
		fireEvent.keyDown(field, { key: 'Escape' });
		expect(props.actions.renameWidget).not.toHaveBeenCalled();
		expect(queryByLabelText('Rename My Clock')).toBeNull();
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
		const { getByText, queryByLabelText } = render(
			<DesignerListPanel {...baseProps()} library={{ version: 1, defs: [] }} editingDefId="gone" />
		);
		expect(getByText(/No custom widgets yet/)).toBeTruthy();
		expect(getByText('My widgets')).toBeTruthy();
		expect(queryByLabelText('Custom widget name')).toBeNull();
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
		fireEvent.click(row.getByTitle(/Clone into a new editable custom widget/));
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
	it('the New custom widget button starts a fresh def', () => {
		const props = baseProps();
		const { getByText } = render(<DesignerListPanel {...props} />);
		fireEvent.click(getByText('＋ New custom widget'));
		expect(props.actions.startNewWidget).toHaveBeenCalledTimes(1);
	});

	it('Copy widget reference copies markdown and reports success inline', async () => {
		const { getByText, findByRole } = render(<DesignerListPanel {...baseProps()} />);
		fireEvent.click(getByText('⧉ Copy widget reference'));
		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledTimes(1));
		// The copied payload is the generated widget-reference markdown (non-empty).
		const md = vi.mocked(copyToClipboard).mock.calls[0][0];
		expect(typeof md).toBe('string');
		expect(md.length).toBeGreaterThan(0);
		expect((await findByRole('status')).textContent).toMatch(/copied/i);
	});

	it('reports a failure inline (and does not claim success) when the copy fails', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		vi.mocked(copyToClipboard).mockResolvedValueOnce(false);
		const { getByText, findByRole } = render(<DesignerListPanel {...baseProps()} />);
		fireEvent.click(getByText('⧉ Copy widget reference'));
		expect((await findByRole('status')).textContent).toMatch(/Copy failed/i);
		expect(log).toHaveBeenCalledOnce();
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
