// The ONE localStorage seam (outer ring). Every persisted UI preference / store goes through
// these helpers instead of hand-rolling try/catch JSON — storage may be unavailable (private
// mode / quota), so reads fall back and writes are best-effort, silently.
//
// Key convention: new keys are namespaced 'widgetsack.<area>.<name>' (e.g.
// 'widgetsack.studio.panes'). Legacy keys ('_mediaStore', 'ha.exposed') keep their historical
// names — renaming would orphan users' saved state.
import { createStore, type ExternalStore } from './createStore';

/** Parsed JSON at `key`, or null when missing/corrupt/unavailable. Callers validate the shape. */
export function readJson(key: string): unknown {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? null : (JSON.parse(raw) as unknown);
	} catch {
		return null;
	}
}

/** Best-effort JSON write; a failure just means the value won't survive this session. */
export function writeJson(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* ignore quota / unavailable */
	}
}

/** Raw string at `key` (NOT JSON — for keys that store a bare string), or null. */
export function readString(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

/** Best-effort raw string write. */
export function writeString(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* ignore quota / unavailable */
	}
}

/**
 * An ExternalStore seeded from localStorage that persists on every change. `parse` receives the
 * stored JSON (or null) and must return a full value — it owns validation and defaults.
 * `serialize` picks what is written back (defaults to the whole value); use it when the store
 * holds runtime-only fields that must not persist. Persists once at creation too (so defaults
 * land on first run) and via a module-level subscription, decoupled from React mounts.
 *
 * Every window (overlay, studio) holds its own copy, so a change writes only when its serialized
 * form differs from what this window last wrote or adopted — a runtime-only change (a media
 * session tick) must not overwrite another window's newer preferences. Another window's write
 * arrives as a `storage` event and is folded in through `merge` (default: take it whole).
 */
export function createPersistedStore<T>(
	key: string,
	parse: (raw: unknown) => T,
	serialize: (value: T) => unknown = (v) => v,
	merge: (current: T, incoming: T) => T = (_current, incoming) => incoming
): ExternalStore<T> {
	const store = createStore<T>(parse(readJson(key)));
	let last = '';
	const persist = (): void => {
		const json = JSON.stringify(serialize(store.getSnapshot()));
		if (json === last) return;
		last = json;
		writeString(key, json);
	};
	persist();
	store.subscribe(persist);
	window.addEventListener('storage', (event) => {
		if (event.key !== key) return;
		const incoming = parse(readJson(key));
		last = JSON.stringify(serialize(incoming));
		store.set(merge(store.getSnapshot(), incoming));
	});
	return store;
}
