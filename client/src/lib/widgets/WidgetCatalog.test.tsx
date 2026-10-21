import { fireEvent, render } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import WidgetCatalog from './WidgetCatalog';
vi.mock('./WidgetPreview', () => ({ default: () => <span>Sample widget</span> }));
beforeEach(() => localStorage.clear());
it('stars catalog items, filters favourites and removes a favourite without adding the item', () => {
	const onOp = vi.fn();
	const view = render(
		<WidgetCatalog
			workspace
			widgetTypes={[
				{ type: 'clock', label: 'Clock' },
				{ type: 'bar', label: 'Bar' }
			]}
			onOp={onOp}
		/>
	);
	fireEvent.click(view.getByRole('button', { name: 'Add Clock to favourites' }));
	expect(onOp).not.toHaveBeenCalled();
	fireEvent.click(view.getByRole('tab', { name: 'Favourites' }));
	expect(view.getByRole('button', { name: /^Clock —/ })).toBeVisible();
	expect(view.queryByRole('button', { name: /^Bar —/ })).toBeNull();
	fireEvent.click(view.getByRole('button', { name: 'Remove Clock from favourites' }));
	expect(view.getByRole('status')).toHaveTextContent('No favourites yet');
	fireEvent.click(view.getByRole('tab', { name: 'Templates' }));
	fireEvent.click(view.getByRole('button', { name: 'Add System monitor to favourites' }));
	fireEvent.click(view.getByRole('tab', { name: 'Favourites' }));
	expect(view.getByRole('button', { name: 'Set up System monitor' })).toBeVisible();
});
it('uses the compact category picker in Build and starts a selected built-in', () => {
	const onNewFromWidget = vi.fn();
	const view = render(
		<WidgetCatalog
			context="build"
			workspace
			widgetTypes={[{ type: 'clock', label: 'Clock' }]}
			onNewFromWidget={onNewFromWidget}
		/>
	);
	fireEvent.click(view.getByRole('combobox', { name: 'Catalog section' }));
	fireEvent.click(view.getByRole('option', { name: 'Widgets' }));
	fireEvent.click(view.getByRole('button', { name: /^Clock —/ }));
	expect(onNewFromWidget).toHaveBeenCalledWith('clock');
});
