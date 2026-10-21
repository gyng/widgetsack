import { useCallback, useEffect, useRef, useState } from 'react';

const KEY = 'widgetsack.catalog.favourites';
const CHANGED = 'widgetsack:catalog-favourites';
function readFavourites(): string[] {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
		return Array.isArray(value)
			? [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))]
			: [];
	} catch {
		return [];
	}
}
/** One preference across both catalog hosts; writes never affect the layout document. */
export function useCatalogFavourites() {
	const [favourites, setFavourites] = useState(readFavourites);
	const current = useRef(favourites);
	useEffect(() => {
		const update = (next: string[]) => {
			current.current = next;
			setFavourites(next);
		};
		const onStorage = (event: StorageEvent) => {
			if (event.key === KEY || event.key === null) update(readFavourites());
		};
		const onChange = (event: Event) => update((event as CustomEvent<string[]>).detail);
		window.addEventListener('storage', onStorage);
		window.addEventListener(CHANGED, onChange);
		return () => {
			window.removeEventListener('storage', onStorage);
			window.removeEventListener(CHANGED, onChange);
		};
	}, []);
	const toggle = useCallback((key: string) => {
		const next = current.current.includes(key)
			? current.current.filter((value) => value !== key)
			: [...current.current, key];
		current.current = next;
		setFavourites(next);
		try {
			localStorage.setItem(KEY, JSON.stringify(next));
		} catch {
			/* Keep the current session usable. */
		}
		window.dispatchEvent(new CustomEvent(CHANGED, { detail: next }));
	}, []);
	return { favourites, toggle };
}
