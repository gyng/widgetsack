import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import SavedLayoutsPanel from './SavedLayoutsPanel';

// Presentational: the inline name field + Save (no prompt), the outcome line from the hook, and the
// load / delete rows. The file I/O lives in useSavedLayouts (tested there).
const props = () => ({
	layoutNames: [] as string[],
	status: null,
	onSave: vi.fn(),
	onLoad: vi.fn(),
	onDelete: vi.fn()
});

describe('SavedLayoutsPanel', () => {
	it('saves under the typed name from the inline field (Save is inert while blank)', () => {
		const p = props();
		const { getByLabelText, getByRole } = render(<SavedLayoutsPanel {...p} />);
		const save = getByRole('button', { name: 'Save' }) as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		fireEvent.change(getByLabelText('Layout name'), { target: { value: 'Gaming' } });
		expect(save.disabled).toBe(false);
		fireEvent.click(save);
		expect(p.onSave).toHaveBeenCalledWith('Gaming');
	});

	it('shows the hook’s outcome line as a status (ok) or an alert (error)', () => {
		const p = props();
		const { getByRole, rerender } = render(
			<SavedLayoutsPanel
				{...p}
				status={{ kind: 'ok', message: 'Saved layout Gaming · 1 layout' }}
			/>
		);
		expect(getByRole('status').textContent).toBe('Saved layout Gaming · 1 layout');
		rerender(<SavedLayoutsPanel {...p} status={{ kind: 'error', message: 'Could not save' }} />);
		expect(getByRole('alert').textContent).toBe('Could not save');
	});

	it('lists the presets with load + delete, and an empty stub otherwise', () => {
		const p = props();
		const { getByText, getByRole, getByLabelText, rerender } = render(<SavedLayoutsPanel {...p} />);
		expect(getByText(/No saved layouts yet/)).toBeTruthy();
		rerender(<SavedLayoutsPanel {...p} layoutNames={['Home', 'Work']} />);
		fireEvent.click(getByRole('button', { name: 'Work' }));
		expect(p.onLoad).toHaveBeenCalledWith('Work');
		fireEvent.click(getByLabelText('Delete saved layout Home'));
		expect(p.onDelete).toHaveBeenCalledWith('Home');
	});
});

it('lets users load the shipped preset without offering to delete it', () => {
	const p = props();
	const { getByRole, queryByLabelText } = render(
		<SavedLayoutsPanel {...p} layoutNames={['Built-in: Local desktop']} />
	);
	fireEvent.click(getByRole('button', { name: 'Built-in: Local desktop' }));
	expect(p.onLoad).toHaveBeenCalledWith('Built-in: Local desktop');
	expect(queryByLabelText('Delete saved layout Built-in: Local desktop')).toBeNull();
});
