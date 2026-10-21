import { render, screen, fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import StudioStageToolbar from './StudioStageToolbar';

it('keeps core actions separate from drop options and preserves their callbacks', () => {
	const undo = vi.fn(),
		redo = vi.fn(),
		fit = vi.fn(),
		focus = vi.fn(),
		copyDebug = vi.fn(),
		onDropIntoFlow = vi.fn(),
		onDropIntoCells = vi.fn();
	const props = {
		canUndo: false,
		canRedo: false,
		undo,
		redo,
		fit,
		focus,
		copyDebug,
		onDropIntoFlow,
		onDropIntoCells,
		zoom: 0.333,
		dropIntoFlow: false,
		dropIntoCells: false,
		developer: false
	};
	const view = render(<StudioStageToolbar {...props} />);
	expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
	expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
	expect(screen.getByLabelText('Zoom level')).toHaveTextContent('33%');
	expect(screen.queryByText('⧉ Copy debug')).toBeNull();
	fireEvent.click(screen.getByRole('button', { name: 'Canvas options' }));
	expect(view.container.querySelector('.stage-options')).toHaveStyle({
		left: '8px',
		width: '210px'
	});
	view.rerender(<StudioStageToolbar {...props} canUndo canRedo developer />);
	for (const [name, callback] of [
		['Undo', undo],
		['Redo', redo],
		['Fit', fit],
		['Zoom to content', focus]
	] as const) {
		fireEvent.click(screen.getByRole('button', { name }));
		expect(callback).toHaveBeenCalledOnce();
	}
	fireEvent.click(screen.getByLabelText('into grids'));
	expect(onDropIntoFlow).toHaveBeenCalledWith(true);
	fireEvent.click(screen.getByLabelText('into cells'));
	expect(onDropIntoCells).toHaveBeenCalledWith(true);
	fireEvent.click(screen.getByText('⧉ Copy debug'));
	expect(copyDebug).toHaveBeenCalledOnce();
});
