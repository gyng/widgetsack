import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import WidgetStartDialog from './WidgetStartDialog';
it('offers useful starting points and keeps blank creation under Advanced', () => {
	const onChoose = vi.fn();
	const onBlank = vi.fn();
	const onClose = vi.fn();
	const view = render(
		<WidgetStartDialog onChoose={onChoose} onBlank={onBlank} onClose={onClose} />
	);
	for (const [name, tab] of [
		['Start with a template', 'Templates'],
		['Start with a built-in widget', 'Widgets'],
		['Copy from My widgets', 'My widgets']
	]) {
		fireEvent.click(view.getByRole('button', { name }));
		expect(onChoose).toHaveBeenLastCalledWith(tab);
	}
	expect(onBlank).not.toHaveBeenCalled();
	fireEvent.click(view.getByText('Advanced'));
	fireEvent.click(view.getByRole('button', { name: 'Create blank widget' }));
	expect(onBlank).toHaveBeenCalledOnce();
	fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
	expect(onClose).toHaveBeenCalledOnce();
	fireEvent.keyDown(view.getByRole('dialog'), { key: 'Escape' });
	expect(onClose).toHaveBeenCalledTimes(2);
	fireEvent.keyDown(view.getByRole('dialog'), { key: 'Tab', shiftKey: true });
});
