import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mediaStore + handle* reducers are an orchestration-ring module: pure TS types mirroring the
// Rust session structs (state.rs), a localStorage-backed external store (via persist.ts), and three
// reducers folded over the live session map. The store is created at module load from
// localStorage, so each test re-imports the module after seeding/clearing storage to exercise the
// parse seam (parseMediaStore) and the persisted defaults (serializeMediaStore) deterministically.

type Stores = typeof import('./stores');
const MEDIA_STORE_KEY = '_mediaStore';

const load = async (): Promise<Stores> => {
	vi.resetModules();
	return import('./stores');
};

// A minimal SessionRecord with just the fields the reducers/priority touch.
const rec = (
	over: Partial<import('./stores').SessionRecord> = {}
): import('./stores').SessionRecord => ({
	session_id: 1,
	source: 'foobar2000.exe',
	timestamp_created: null,
	timestamp_updated: null,
	last_media_update: null,
	last_model_update: null,
	...over
});

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('defaultState', () => {
	it('seeds the priority list lowercased and newline-joined', async () => {
		const { defaultState } = await load();
		expect(defaultState.sessions).toEqual({});
		expect(defaultState.sourcePriority).toBe(
			'spotifyab.spotifymusic_zpdnekdrzrea0!spotify\nfoobar2000.exe'
		);
		expect(defaultState.ignoreList).toBe('');
		expect(defaultState.restoreToSavedPosition).toBe(false);
		expect(defaultState.preferredMonitor).toBeNull();
		expect(defaultState.savedPosition).toBeNull();
	});
});

describe('mediaStore creation (parseMediaStore seam)', () => {
	it('falls back to defaults when storage is empty', async () => {
		const { mediaStore, defaultState } = await load();
		expect(mediaStore.getSnapshot()).toEqual(defaultState);
	});

	it('falls back to defaults when storage is the literal null JSON', async () => {
		localStorage.setItem(MEDIA_STORE_KEY, 'null');
		const { mediaStore, defaultState } = await load();
		expect(mediaStore.getSnapshot().sourcePriority).toBe(defaultState.sourcePriority);
	});

	it('overlays every persisted SerializedState field over the defaults', async () => {
		const monitor = { name: 'DISPLAY1', position: { x: 0, y: 0 }, size: { width: 1, height: 1 } };
		const saved = { x: 1, y: 2, width: 3, height: 4, timestamp: 5 };
		localStorage.setItem(
			MEDIA_STORE_KEY,
			JSON.stringify({
				sourcePriority: 'a\nb',
				ignoreList: 'spotify',
				styleOverride: '.np {}',
				preferredMonitor: monitor,
				savedPosition: saved,
				restoreToSavedPosition: true
			})
		);
		const { mediaStore } = await load();
		const s = mediaStore.getSnapshot();
		expect(s.sourcePriority).toBe('a\nb');
		expect(s.ignoreList).toBe('spotify');
		expect(s.styleOverride).toBe('.np {}');
		expect(s.preferredMonitor).toEqual(monitor);
		expect(s.savedPosition).toEqual(saved);
		expect(s.restoreToSavedPosition).toBe(true);
		// runtime-only field stays at its default
		expect(s.sessions).toEqual({});
	});

	it('keeps defaults for fields the persisted blob omits (partial state)', async () => {
		localStorage.setItem(MEDIA_STORE_KEY, JSON.stringify({ ignoreList: 'x' }));
		const { mediaStore, defaultState } = await load();
		const s = mediaStore.getSnapshot();
		expect(s.ignoreList).toBe('x');
		// untouched → default
		expect(s.sourcePriority).toBe(defaultState.sourcePriority);
		expect(s.restoreToSavedPosition).toBe(false);
	});

	it('treats an explicit null preferredMonitor as "provided" (overlays it)', async () => {
		// preferredMonitor defaults to null; assert the `!== undefined` branch accepts an explicit null
		localStorage.setItem(
			MEDIA_STORE_KEY,
			JSON.stringify({ preferredMonitor: null, savedPosition: null, restoreToSavedPosition: false })
		);
		const { mediaStore } = await load();
		expect(mediaStore.getSnapshot().preferredMonitor).toBeNull();
	});

	it('falls back per field when persisted preferences have invalid types or shapes', async () => {
		localStorage.setItem(
			MEDIA_STORE_KEY,
			JSON.stringify({
				sourcePriority: 7,
				ignoreList: ['spotify'],
				styleOverride: false,
				preferredMonitor: { name: 1, position: { x: 0 }, size: null },
				savedPosition: { x: 1, y: 2, width: -3, height: 4, timestamp: 5 },
				restoreToSavedPosition: 'yes'
			})
		);

		const { mediaStore, defaultState } = await load();

		expect(mediaStore.getSnapshot()).toEqual(defaultState);
	});

	it('accepts a structurally valid monitor and finite positive saved position', async () => {
		const preferredMonitor = {
			name: null,
			position: { x: -1920, y: 0 },
			size: { width: 1920, height: 1080 }
		};
		const savedPosition = { x: 10, y: 20, width: 500, height: 300, timestamp: 123 };
		localStorage.setItem(
			MEDIA_STORE_KEY,
			JSON.stringify({ preferredMonitor, savedPosition, restoreToSavedPosition: true })
		);

		const { mediaStore } = await load();

		expect(mediaStore.getSnapshot().preferredMonitor).toEqual(preferredMonitor);
		expect(mediaStore.getSnapshot().savedPosition).toEqual(savedPosition);
		expect(mediaStore.getSnapshot().restoreToSavedPosition).toBe(true);
	});
});

describe('serializeMediaStore (persist seam)', () => {
	it('persists exactly the SerializedState subset on creation — never the runtime sessions', async () => {
		const { mediaStore } = await load();
		mediaStore.update((cur) => ({
			...cur,
			sessions: { 1: rec() } as Record<string, import('./stores').SessionRecord>,
			ignoreList: 'persist-me'
		}));
		const written = JSON.parse(localStorage.getItem(MEDIA_STORE_KEY) ?? '{}');
		expect(written.ignoreList).toBe('persist-me');
		expect(Object.keys(written).sort()).toEqual(
			[
				'ignoreList',
				'preferredMonitor',
				'restoreToSavedPosition',
				'savedPosition',
				'sourcePriority',
				'styleOverride'
			].sort()
		);
		// sessions must NOT cross into storage
		expect('sessions' in written).toBe(false);
	});
});

describe('handleInitialize', () => {
	it('does nothing when opts is falsy', async () => {
		const { mediaStore, handleInitialize } = await load();
		const before = mediaStore.getSnapshot();
		// @ts-expect-error exercising the falsy guard
		handleInitialize(undefined);
		expect(mediaStore.getSnapshot()).toBe(before);
	});

	it('folds the backend snapshot through upsertSession into the store', async () => {
		const { mediaStore, handleInitialize } = await load();
		handleInitialize({
			sessions: {
				1: rec({ session_id: 1, source: 'a.exe' }),
				2: rec({ session_id: 2, source: 'b.exe' })
			}
		});
		const s = mediaStore.getSnapshot().sessions;
		expect(Object.keys(s).sort()).toEqual(['1', '2']);
		expect(s[1].source).toBe('a.exe');
		expect(s[2].source).toBe('b.exe');
	});

	it('dedupes a same-source duplicate in the initial set (no startup leak seed)', async () => {
		const { mediaStore, handleInitialize } = await load();
		handleInitialize({
			sessions: {
				1: rec({ session_id: 1, source: 'dup.exe' }),
				2: rec({ session_id: 2, source: 'dup.exe' })
			}
		});
		const s = mediaStore.getSnapshot().sessions;
		// only the later upsert for that source survives
		expect(Object.keys(s)).toEqual(['2']);
	});
});

describe('handleUpdate', () => {
	it('inserts a never-seen session keyed by session_id', async () => {
		const { mediaStore, handleUpdate } = await load();
		handleUpdate({ sessionRecord: rec({ session_id: 7, source: 's.exe' }) });
		expect(mediaStore.getSnapshot().sessions[7].source).toBe('s.exe');
	});

	it('carries prior media forward when an update omits last_media_update', async () => {
		const { mediaStore, handleUpdate } = await load();
		const media = {
			Media: [{ playback: null, timeline: null, media: null, source: 's.exe' }, { bytes: 42 }]
		} as import('./stores').SessionUpdateEventMedia;
		// first: a real media update
		handleUpdate({
			sessionRecord: rec({ session_id: 3, source: 's.exe', last_media_update: media })
		});
		// then: a model/timeline tick with no media → prior media is restored
		handleUpdate({
			sessionRecord: rec({ session_id: 3, source: 's.exe', last_media_update: null })
		});
		expect(mediaStore.getSnapshot().sessions[3].last_media_update).toEqual(media);
	});

	it('evicts a stale record for the SAME source recreated under a new id', async () => {
		const { mediaStore, handleUpdate } = await load();
		handleUpdate({ sessionRecord: rec({ session_id: 1, source: 'player.exe' }) });
		handleUpdate({ sessionRecord: rec({ session_id: 2, source: 'player.exe' }) });
		const s = mediaStore.getSnapshot().sessions;
		expect(Object.keys(s)).toEqual(['2']);
	});
});

describe('handleDelete', () => {
	it('removes the record for the given session_id', async () => {
		const { mediaStore, handleUpdate, handleDelete } = await load();
		handleUpdate({ sessionRecord: rec({ session_id: 9, source: 'x.exe' }) });
		const previous = mediaStore.getSnapshot();
		expect(previous.sessions[9]).toBeDefined();
		handleDelete({ sessionRecord: rec({ session_id: 9, source: 'x.exe' }) });
		expect(mediaStore.getSnapshot().sessions[9]).toBeUndefined();
		expect(mediaStore.getSnapshot().sessions).toEqual({});
		// External-store snapshots are immutable contracts: deleting from the new state must not
		// retroactively mutate a value a React render (or another subscriber) already captured.
		expect(previous.sessions[9]).toBeDefined();
	});

	it('is a no-op (leaves other sessions intact) when the id is absent', async () => {
		const { mediaStore, handleUpdate, handleDelete } = await load();
		handleUpdate({ sessionRecord: rec({ session_id: 1, source: 'a.exe' }) });
		handleDelete({ sessionRecord: rec({ session_id: 999, source: 'gone.exe' }) });
		expect(Object.keys(mediaStore.getSnapshot().sessions)).toEqual(['1']);
	});
});
