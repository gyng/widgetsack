import { describe, expect, it } from 'vitest';
import type { PlaybackModel, SessionModel, SessionRecord } from '../../../stores/stores';
import {
	filterIgnored,
	mergeMediaForward,
	sortSessionsByPriority,
	sumArtBytes,
	upsertSession
} from './priority';

const playback: PlaybackModel = {
	auto_repeat: 'None',
	rate: 0,
	shuffle: false,
	status: 'Playing',
	type: 'Unknown'
};

const session: SessionModel = {
	playback: playback,
	timeline: null,
	media: null,
	source: 'set_me'
};

const sessionRecord: SessionRecord = {
	session_id: 0,
	source: '',
	timestamp_created: null,
	timestamp_updated: null,
	last_media_update: {
		Media: [
			{
				playback: null,
				timeline: null,
				media: {
					album: null,
					artist: 'fooartist',
					genres: [],
					playback_type: 'Music',
					subtitle: '',
					title: 'bartitle',
					track_number: null
				},
				source: 'test.exe'
			},
			null
		]
	},
	last_model_update: {
		Model: {
			playback: null,
			timeline: null,
			media: null,
			source: ''
		}
	}
};

describe('priority', () => {
	it('sorts media by priority in list', () => {
		const sessions: Record<number, SessionRecord> = {
			0: {
				...sessionRecord,
				session_id: 0,
				source: 'foobar'
			},
			2: {
				...sessionRecord,
				session_id: 2,
				source: 'barbaz'
			},
			4: {
				...sessionRecord,
				session_id: 4,
				source: 'notinlist'
			}
		};
		const priority = 'barbaz\nfoobar';

		const sorted = sortSessionsByPriority(sessions, priority);

		expect(sorted.at(2)!.source).toBe('barbaz');
		expect(sorted.at(1)!.source).toBe('foobar');
		expect(sorted.at(0)!.source).toBe('notinlist');
	});

	it('sorts media by playing status after sorting by priority list', () => {
		const sessions: Record<number, SessionRecord> = {
			0: {
				...sessionRecord,
				session_id: 0,
				source: 'foobar',
				last_model_update: { Model: { ...session, playback: { ...playback, status: 'Playing' } } }
			},
			2: {
				...sessionRecord,
				session_id: 2,
				source: 'barbaz',
				last_model_update: { Model: { ...session, playback: { ...playback, status: 'Stopped' } } }
			},
			4: {
				...sessionRecord,
				session_id: 4,
				source: 'notinlist',
				last_model_update: { Model: { ...session, playback: { ...playback, status: 'Playing' } } }
			}
		};
		const priority = 'barbaz\nfoobar';

		const sorted = sortSessionsByPriority(sessions, priority);

		expect(sorted.at(0)!.source).toBe('foobar');
		expect(sorted.at(1)!.source).toBe('notinlist');
		expect(sorted.at(2)!.source).toBe('barbaz');
	});

	it('treats a session with no `source` field as unranked (falls through the ?? fallback)', () => {
		// A malformed/legacy record missing `source` entirely (not just empty) — the `a?.source` /
		// `b?.source` optional chains yield undefined, exercising the `?? '_____FIXME_____'` fallback.
		// Mirrors the 'sorts media by priority in list' case, with the unranked session source-less
		// instead of a non-matching string — both must land in the same (last / MAX_VALUE) slot.
		const { source: _drop, ...noSource } = { ...sessionRecord, session_id: 4 };
		void _drop;
		const sessions: Record<number, SessionRecord> = {
			0: { ...sessionRecord, session_id: 0, source: 'foobar' },
			2: { ...sessionRecord, session_id: 2, source: 'barbaz' },
			4: noSource as SessionRecord
		};
		const priority = 'barbaz\nfoobar';
		const sorted = sortSessionsByPriority(sessions, priority);
		expect(sorted.at(2)!.source).toBe('barbaz');
		expect(sorted.at(1)!.source).toBe('foobar');
		expect(sorted.at(0)!.source).toBeUndefined();

		// Same outcome with the source-less record FIRST, so it also lands in the comparator's
		// b-slot (both the `a?.source` and `b?.source` fallbacks run).
		const reversed: Record<number, SessionRecord> = {
			0: { ...(noSource as SessionRecord), session_id: 0 },
			2: { ...sessionRecord, session_id: 2, source: 'barbaz' },
			4: { ...sessionRecord, session_id: 4, source: 'foobar' }
		};
		const sorted2 = sortSessionsByPriority(reversed, priority);
		expect(sorted2.at(2)!.source).toBe('barbaz');
		expect(sorted2.at(1)!.source).toBe('foobar');
		expect(sorted2.at(0)!.source).toBeUndefined();
	});

	it('sorts media by last updated timestamp otherwise', () => {
		const sessions: Record<number, SessionRecord> = {
			0: {
				...sessionRecord,
				session_id: 0,
				source: 'foobar',
				timestamp_updated: { secs_since_epoch: 10, nanos_since_epoch: 0 }
			},
			2: {
				...sessionRecord,
				session_id: 2,
				source: 'barbaz',
				timestamp_updated: { secs_since_epoch: 100, nanos_since_epoch: 0 }
			},
			4: {
				...sessionRecord,
				session_id: 4,
				source: 'notinlist',
				timestamp_updated: { secs_since_epoch: 1000, nanos_since_epoch: 0 }
			}
		};
		const priority = '';

		const sorted = sortSessionsByPriority(sessions, priority);

		expect(sorted.at(2)!.source).toBe('notinlist');
		expect(sorted.at(1)!.source).toBe('barbaz');
		expect(sorted.at(0)!.source).toBe('foobar');
	});
});

describe('filterIgnored', () => {
	const make = (sources: Record<number, string>): Record<number, SessionRecord> =>
		Object.fromEntries(
			Object.entries(sources).map(([id, source]) => [
				Number(id),
				{ ...sessionRecord, session_id: Number(id), source }
			])
		);

	it('drops sessions whose source matches an ignore term', () => {
		const sessions = make({ 0: 'foobar2000.exe', 1: 'spotify.exe' });
		const kept = filterIgnored(sessions, 'foobar2000');
		expect(Object.values(kept).map((s) => s.source)).toEqual(['spotify.exe']);
	});

	it('is a no-op for an empty / blank-only list', () => {
		const sessions = make({ 0: 'foobar2000.exe', 1: 'spotify.exe' });
		expect(filterIgnored(sessions, '')).toBe(sessions);
		expect(filterIgnored(sessions, '   \n\n  ')).toBe(sessions);
	});

	it('matches case-insensitively', () => {
		const sessions = make({ 0: 'FooBar2000.EXE', 1: 'spotify.exe' });
		const kept = filterIgnored(sessions, 'FOOBAR2000');
		expect(Object.values(kept).map((s) => s.source)).toEqual(['spotify.exe']);
	});

	it('honours multiple terms, ignoring blank lines', () => {
		const sessions = make({ 0: 'foobar2000.exe', 1: 'spotify.exe', 2: 'chrome.exe' });
		const kept = filterIgnored(sessions, 'foobar2000\n\nchrome');
		expect(Object.values(kept).map((s) => s.source)).toEqual(['spotify.exe']);
	});

	it('treats a record with no `source` field as an empty string, not a match', () => {
		const { source: _drop, ...noSource } = { ...sessionRecord, session_id: 3 };
		void _drop;
		const sessions: Record<number, SessionRecord> = { 3: noSource as SessionRecord };
		const kept = filterIgnored(sessions, 'foobar2000');
		// '' doesn't contain 'foobar2000' → the record survives the filter.
		expect(Object.keys(kept)).toEqual(['3']);
	});
});

describe('upsertSession', () => {
	const rec = (session_id: number, source: string): SessionRecord => ({
		...sessionRecord,
		session_id,
		source
	});

	it('replaces the record for the same session_id without growing the map', () => {
		const sessions = { 7: rec(7, 'spotify.exe') };
		const next = upsertSession(sessions, rec(7, 'spotify.exe'));
		expect(Object.keys(next)).toEqual(['7']);
	});

	it('evicts a stale entry that shares the source under a different session_id (the leak fix)', () => {
		// Spotify recreated its SMTC session: same source, new id, no session_delete for the old one.
		const sessions = { 7: rec(7, 'spotify.exe'), 9: rec(9, 'foobar2000.exe') };
		const next = upsertSession(sessions, rec(12, 'spotify.exe'));
		// The orphaned id 7 (and its retained art bytes) is gone; the unrelated player survives.
		expect(Object.keys(next).sort()).toEqual(['12', '9']);
		expect(next[12].source).toBe('spotify.exe');
		expect(next[9].source).toBe('foobar2000.exe');
	});

	it('keeps sessions with distinct sources', () => {
		const sessions = { 1: rec(1, 'spotify.exe') };
		const next = upsertSession(sessions, rec(2, 'foobar2000.exe'));
		expect(Object.keys(next).sort()).toEqual(['1', '2']);
	});

	it('does not dedupe a record with no source (can not identify the player)', () => {
		const sessions = { 1: rec(1, ''), 2: rec(2, '') };
		const next = upsertSession(sessions, rec(3, ''));
		expect(Object.keys(next).sort()).toEqual(['1', '2', '3']);
	});

	it('returns a new map (does not mutate the input)', () => {
		const sessions = { 7: rec(7, 'spotify.exe') };
		const next = upsertSession(sessions, rec(8, 'spotify.exe'));
		expect(next).not.toBe(sessions);
		expect(Object.keys(sessions)).toEqual(['7']); // original untouched
	});
});

describe('mergeMediaForward', () => {
	// A record whose media (title/art) is present, vs a model-only update that omits it.
	const withMedia = (session_id: number): SessionRecord => ({
		...sessionRecord,
		session_id,
		last_media_update: {
			Media: [{ ...session, source: 'p.exe' }, { url: 'http://art.localhost/1' }]
		}
	});
	const modelOnly = (session_id: number): SessionRecord => ({
		...sessionRecord,
		session_id,
		last_media_update: null,
		last_model_update: { Model: { ...session, playback: { ...playback, status: 'Paused' } } }
	});

	it('carries the previous media forward when the update omits it (paused/seek tick)', () => {
		const prev = withMedia(7);
		const merged = mergeMediaForward(prev, modelOnly(7));
		// Cover + metadata preserved from prev; the new model (Paused) is taken from the incoming record.
		expect(merged.last_media_update).toBe(prev.last_media_update);
		expect(merged.last_model_update?.Model?.playback?.status).toBe('Paused');
	});

	it('keeps the incoming media when the update carries its own (real track change)', () => {
		const prev = withMedia(7);
		const incoming = withMedia(7);
		const merged = mergeMediaForward(prev, incoming);
		expect(merged.last_media_update).toBe(incoming.last_media_update);
	});

	it('is a no-op for a first-seen session (no prev to carry from)', () => {
		const incoming = modelOnly(9);
		expect(mergeMediaForward(undefined, incoming)).toBe(incoming);
		expect(mergeMediaForward(undefined, incoming).last_media_update).toBeNull();
	});
});

describe('sumArtBytes', () => {
	const withArt = (session_id: number, bytes: number): SessionRecord => ({
		...sessionRecord,
		session_id,
		last_media_update: { Media: [{ ...session, source: 'p.exe' }, { bytes }] }
	});

	it('sums album-art byte counts across sessions', () => {
		const sessions = { 1: withArt(1, 3), 2: withArt(2, 2) };
		expect(sumArtBytes(sessions)).toBe(5);
	});

	it('ignores sessions with no art (null media or no bytes)', () => {
		const sessions = {
			1: withArt(1, 3),
			2: { ...sessionRecord, session_id: 2, last_media_update: null },
			3: { ...sessionRecord, session_id: 3 } // fixture default: Media[1] is null
		};
		expect(sumArtBytes(sessions)).toBe(3);
	});

	it('is 0 for an empty set', () => {
		expect(sumArtBytes({})).toBe(0);
	});
});
