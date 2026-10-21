import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { container, leaf } from '../core/layoutTree';
import { createWidget } from '../core/widget';
import ArrangeSelectionDialog from './ArrangeSelectionDialog';
const monitor = {
	root: container('root', 'row', [
		leaf(createWidget('clock', 'a')),
		leaf(createWidget('clock', 'b'))
	]),
	floating: []
};
it('previews choices, applies once and keeps a changed-layout error visible', () => {
	const onApply = vi.fn(() => false);
	const onClose = vi.fn();
	const view = render(
		<ArrangeSelectionDialog
			monitor={monitor}
			ids={['root']}
			measured={new Map()}
			natural={new Map()}
			onApply={onApply}
			onClose={onClose}
		/>
	);
	expect(onApply).not.toHaveBeenCalled();
	for (const name of [
		'Arrange in a row',
		'Equal horizontal spacing',
		'Equal vertical spacing',
		'Fit to content',
		'Stack vertically'
	])
		fireEvent.click(view.getByRole('button', { name }));
	expect(view.getByRole('img', { name: 'After arrangement' })).toBeVisible();
	fireEvent.click(view.getByRole('button', { name: 'Apply arrangement' }));
	expect(view.getByRole('alert')).toHaveTextContent('layout changed');
	expect(onClose).not.toHaveBeenCalled();
	onApply.mockReturnValue(true);
	fireEvent.click(view.getByRole('button', { name: 'Apply arrangement' }));
	expect(onClose).toHaveBeenCalledOnce();
	fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
	fireEvent.keyDown(view.getByRole('dialog'), { key: 'Escape' });
	expect(onClose).toHaveBeenCalledTimes(3);
	fireEvent.keyDown(view.getByRole('dialog'), { key: 'Tab', shiftKey: true });
});
it('explains an unusable selection and disables Apply', () => {
	const view = render(
		<ArrangeSelectionDialog
			monitor={monitor}
			ids={[]}
			measured={new Map()}
			natural={new Map()}
			onApply={vi.fn()}
			onClose={vi.fn()}
		/>
	);
	expect(view.getByRole('status')).toHaveTextContent('Select');
	expect(view.getByRole('button', { name: 'Apply arrangement' })).toBeDisabled();
});
