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
		const { getByLabelText, getByText } = render(<SavedLayoutsPanel {...p} />);
		const save = getByText('⤓ Save') as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		fireEvent.change(getByLabelText('Preset name'), { target: { value: 'Gaming' } });
		expect(save.disabled).toBe(false);
		fireEvent.click(save);
		expect(p.onSave).toHaveBeenCalledWith('Gaming');
	});

	it('shows the hook’s outcome line as a status (ok) or an alert (error)', () => {
		const p = props();
		const { getByRole, rerender } = render(
			<SavedLayoutsPanel
				{...p}
				status={{ kind: 'ok', message: 'Saved preset Gaming · 1 preset' }}
			/>
		);
		expect(getByRole('status').textContent).toBe('Saved preset Gaming · 1 preset');
		rerender(<SavedLayoutsPanel {...p} status={{ kind: 'error', message: 'Could not save' }} />);
		expect(getByRole('alert').textContent).toBe('Could not save');
	});

	it('lists the presets with load + delete, and an empty stub otherwise', () => {
		const p = props();
		const { getByText, getByLabelText, rerender } = render(<SavedLayoutsPanel {...p} />);
		expect(getByText(/No presets yet/)).toBeTruthy();
		rerender(<SavedLayoutsPanel {...p} layoutNames={['Home', 'Work']} />);
		fireEvent.click(getByText('⤒ Work'));
		expect(p.onLoad).toHaveBeenCalledWith('Work');
		fireEvent.click(getByLabelText('Delete preset Home'));
		expect(p.onDelete).toHaveBeenCalledWith('Home');
	});
});
