import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import SharedWidgetEditDialog from './SharedWidgetEditDialog';
it('explains edit scope and offers a placement-only copy before changing linked widgets', () => {
	const onEdit = vi.fn();
	const onCopy = vi.fn();
	const onClose = vi.fn();
	const props = {
		name: 'Desk clock',
		usage: 'Used in 2 layouts · 3 placements',
		locations: [{ key: 'Desk', count: 3 }],
		loading: true,
		placement: true,
		onEdit,
		onCopy,
		onClose
	};
	const view = render(<SharedWidgetEditDialog {...props} />);
	expect(view.getByRole('button', { name: 'Edit all linked copies' })).toBeDisabled();
	expect(onEdit).not.toHaveBeenCalled();
	view.rerender(<SharedWidgetEditDialog {...props} loading={false} />);
	expect(view.getByText(props.usage)).toBeVisible();
	fireEvent.click(view.getByRole('button', { name: 'Edit only this placement' }));
	expect(onCopy).toHaveBeenCalledOnce();
	fireEvent.click(view.getByRole('button', { name: 'Edit all linked copies' }));
	expect(onEdit).toHaveBeenCalledOnce();
	view.rerender(<SharedWidgetEditDialog {...props} loading={false} placement={false} />);
	fireEvent.click(view.getByRole('button', { name: 'Make a copy' }));
	expect(onCopy).toHaveBeenCalledTimes(2);
	fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
	fireEvent.keyDown(view.getByRole('dialog'), { key: 'Escape' });
	expect(onClose).toHaveBeenCalledTimes(2);
	fireEvent.keyDown(view.getByRole('dialog'), { key: 'Tab' });
});
