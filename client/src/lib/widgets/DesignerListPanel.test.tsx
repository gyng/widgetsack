import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';

// copyToClipboard is a Tauri/clipboard adapter (outer ring) — mock it so the "Copy widget reference"
// button can be exercised without a backend. The panel also calls window.alert after copying.
vi.mock('../overlay', () => ({ copyToClipboard: vi.fn(() => Promise.resolve(true)) }));

import DesignerListPanel from './DesignerListPanel';
import { copyToClipboard } from '../overlay';
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
beforeEach(() => {
	vi.clearAllMocks();
	alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
});
afterEach(() => alertSpy.mockRestore());

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

	it('the per-row icons fire rename / clone / delete for that def', () => {
		const props = baseProps();
		const { getByText } = render(<DesignerListPanel {...props} />);
		const row = within(getByText('My Gauge').closest('.dl-item')! as HTMLElement);
		fireEvent.click(row.getByTitle('Rename widget'));
		expect(props.actions.renameWidget).toHaveBeenCalledWith('def-a', 'My Gauge');
		fireEvent.click(row.getByTitle('Clone to a new widget'));
		expect(props.actions.cloneDefToEdit).toHaveBeenCalledWith('def-a');
		fireEvent.click(row.getByTitle('Delete widget'));
		expect(props.actions.deleteWidget).toHaveBeenCalledWith('def-a', 'My Gauge');
	});

	it('marks the currently-edited def row with the "cur" class', () => {
		const { getByText } = render(<DesignerListPanel {...baseProps()} editingDefId="def-b" />);
		expect(getByText('My Clock').closest('.dl-item')!.className).toContain('cur');
		expect(getByText('My Gauge').closest('.dl-item')!.className).not.toContain('cur');
	});

	it('shows the empty-library stub when there are no defs', () => {
		const { getByText } = render(
			<DesignerListPanel {...baseProps()} library={{ version: 1, defs: [] }} />
		);
		expect(getByText(/No widgets yet/)).toBeTruthy();
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
		fireEvent.click(row.getByTitle(/Clone into a new editable library widget/));
		expect(props.actions.newFromTemplate).toHaveBeenCalledWith('network');
	});

	it('highlights the previewed template row by name', () => {
		const { getByText } = render(<DesignerListPanel {...baseProps()} previewName="Network" />);
		expect(getByText('Network').closest('.dl-item')!.className).toContain('cur');
	});
});

describe('DesignerListPanel header actions', () => {
	it('the New widget button starts a fresh def', () => {
		const props = baseProps();
		const { getByText } = render(<DesignerListPanel {...props} />);
		fireEvent.click(getByText('＋ New widget'));
		expect(props.actions.startNewWidget).toHaveBeenCalledTimes(1);
	});

	it('Copy widget reference copies markdown and alerts success', async () => {
		const { getByText } = render(<DesignerListPanel {...baseProps()} />);
		fireEvent.click(getByText('⧉ Copy widget reference'));
		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledTimes(1));
		// The copied payload is the generated widget-reference markdown (non-empty).
		const md = vi.mocked(copyToClipboard).mock.calls[0][0];
		expect(typeof md).toBe('string');
		expect(md.length).toBeGreaterThan(0);
		await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(expect.stringMatching(/copied/i)));
	});

	it('alerts a failure (and does not claim success) when the copy fails', async () => {
		vi.mocked(copyToClipboard).mockResolvedValueOnce(false);
		const { getByText } = render(<DesignerListPanel {...baseProps()} />);
		fireEvent.click(getByText('⧉ Copy widget reference'));
		await waitFor(() =>
			expect(alertSpy).toHaveBeenCalledWith(expect.stringMatching(/Copy failed/i))
		);
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
