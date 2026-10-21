import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useCatalogFavourites } from './useCatalogFavourites';

it('shares favourites across catalog hosts, persists them and supports removal', () => {
	localStorage.clear();
	const layout = renderHook(useCatalogFavourites);
	const build = renderHook(useCatalogFavourites);
	act(() => layout.result.current.toggle('widget:clock'));
	expect(build.result.current.favourites).toEqual(['widget:clock']);
	expect(JSON.parse(localStorage.getItem('widgetsack.catalog.favourites')!)).toEqual([
		'widget:clock'
	]);
	act(() => build.result.current.toggle('template:network'));
	expect(layout.result.current.favourites).toEqual(['widget:clock', 'template:network']);
	act(() => layout.result.current.toggle('widget:clock'));
	expect(build.result.current.favourites).toEqual(['template:network']);
	layout.unmount();
	build.unmount();
	const restored = renderHook(useCatalogFavourites);
	expect(restored.result.current.favourites).toEqual(['template:network']);
});
it('normalizes malformed preferences and follows storage changes only for its key', () => {
	localStorage.setItem('widgetsack.catalog.favourites', '["widget:clock",42,"widget:clock"]');
	const view = renderHook(useCatalogFavourites);
	expect(view.result.current.favourites).toEqual(['widget:clock']);
	localStorage.setItem('widgetsack.catalog.favourites', 'broken');
	act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' })));
	expect(view.result.current.favourites).toEqual(['widget:clock']);
	act(() =>
		window.dispatchEvent(new StorageEvent('storage', { key: 'widgetsack.catalog.favourites' }))
	);
	expect(view.result.current.favourites).toEqual([]);
	localStorage.setItem('widgetsack.catalog.favourites', '{}');
	act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
	expect(view.result.current.favourites).toEqual([]);
});
it('retains session favourites when preference storage is unavailable', () => {
	const read = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
		throw Error('blocked');
	});
	const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
		throw Error('blocked');
	});
	try {
		const view = renderHook(useCatalogFavourites);
		expect(view.result.current.favourites).toEqual([]);
		act(() => view.result.current.toggle('widget:clock'));
		expect(view.result.current.favourites).toEqual(['widget:clock']);
	} finally {
		read.mockRestore();
		write.mockRestore();
	}
});
