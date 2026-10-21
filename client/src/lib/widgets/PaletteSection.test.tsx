import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import PaletteSection from './PaletteSection';
import AddPaletteFrame from './AddPaletteFrame';
import InspectorViewTabs from './InspectorViewTabs';

afterEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
});
const section = (searching = false) => (
	<PaletteSection id="meters" label="Meters" count={3} searching={searching} setup="Setup">
		Items
	</PaletteSection>
);
const toggle = (element: HTMLDetailsElement, open: boolean) => {
	act(() => {
		element.open = open;
		fireEvent(element, new Event('toggle'));
	});
};
it('remembers collapsed sections across remounts without persisting search expansion', () => {
	localStorage.setItem('widgetsack.palette.collapsed', JSON.stringify(['other']));
	let view = render(section());
	const details = screen.getByText('Meters').closest('details')!;
	expect(screen.getByText('(3)')).toBeVisible();
	expect(details.open).toBe(true);
	toggle(details, false);
	view.unmount();
	view = render(section());
	expect(screen.getByText('Meters').closest('details')!.open).toBe(false);
	view.rerender(section(true));
	const expanded = screen.getByText('Meters').closest('details')!;
	expect(expanded.open).toBe(true);
	fireEvent(expanded, new Event('toggle'));
	view.rerender(section());
	expect(expanded.open).toBe(false);
	toggle(expanded, true);
	expect(JSON.parse(localStorage.getItem('widgetsack.palette.collapsed')!)).toEqual(['other']);
});
it.each(['broken', '{}', '[1,"other"]'])('ignores malformed preference data: %s', (value) => {
	localStorage.setItem('widgetsack.palette.collapsed', value);
	const view = render(
		<PaletteSection id="x" label="Other" count={1} tiles>
			Item
		</PaletteSection>
	);
	expect(view.container.querySelector('details')!.open).toBe(true);
});
it('keeps the catalog usable when preference storage is unavailable', () => {
	vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
		throw new Error('Unavailable');
	});
	vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
		throw new Error('Unavailable');
	});
	const view = render(section());
	const details = view.container.querySelector('details')!;
	toggle(details, false);
	expect(details.open).toBe(false);
});
it('keeps Add widget docked and reports toggles', () => {
	const changed = vi.fn();
	const view = render(
		<AddPaletteFrame open destination="floating" onToggle={changed}>
			Catalog
		</AddPaletteFrame>
	);
	toggle(view.container.querySelector('details')!, false);
	expect(changed).toHaveBeenCalledWith(false);
});
it('supports roving inspector tabs and separates catalog accessibility', () => {
	const onSelect = vi.fn();
	const view = render(
		<InspectorViewTabs
			values={['Content', 'Layout', 'JSON']}
			active="Content"
			onSelect={onSelect}
		/>
	);
	const tabs = screen.getByRole('tablist');
	for (const [key, value] of [
		['ArrowRight', 'Layout'],
		['ArrowLeft', 'JSON'],
		['Home', 'Content'],
		['End', 'JSON']
	]) {
		fireEvent.keyDown(tabs, { key });
		expect(onSelect).toHaveBeenLastCalledWith(value);
	}
	fireEvent.keyDown(tabs, { key: 'Escape' });
	fireEvent.click(screen.getByRole('tab', { name: 'Layout' }));
	expect(onSelect).toHaveBeenLastCalledWith('Layout');
	view.rerender(
		<InspectorViewTabs
			palette
			values={['Widgets', 'Templates']}
			active="Widgets"
			onSelect={onSelect}
		/>
	);
	expect(screen.getByRole('tablist', { name: 'Catalog view' })).toBeVisible();
	expect(screen.getByRole('tab', { name: 'Widgets' })).not.toHaveAttribute('aria-controls');
});
