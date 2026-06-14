import type { SessionRecord } from '../../../stores/stores';

// Drop sessions whose source is on the ignore list. `ignoreList` is the newline-separated,
// (already-lowercased) blocklist from the store; a session is hidden if any non-blank line is a
// substring of its lowercased source — so typing `foobar2000` blocks `foobar2000.exe`. Pure.
export const filterIgnored = (
	sessions: Record<number, SessionRecord>,
	ignoreList: string
): Record<number, SessionRecord> => {
	const terms = ignoreList
		.split('\n')
		.map((t) => t.trim().toLowerCase())
		.filter(Boolean);
	if (!terms.length) return sessions;
	const kept: Record<number, SessionRecord> = {};
	for (const [id, rec] of Object.entries(sessions)) {
		const source = (rec?.source ?? '').toLowerCase();
		if (!terms.some((t) => source.includes(t))) kept[Number(id)] = rec;
	}
	return kept;
};

export const sortSessionsByPriority = (
	currentSessions: Record<number, SessionRecord>,
	sourcePriority: string
) => {
	const orderedMedia = Object.values(currentSessions)
		.sort(
			(a, b) =>
				(b?.timestamp_updated?.secs_since_epoch ?? 0) -
				(a?.timestamp_updated?.secs_since_epoch ?? 0)
		)
		.sort((a, b) => {
			let aPriority = sourcePriority.indexOf(a?.source?.toLowerCase() ?? '_____FIXME_____');
			let bPriority = sourcePriority.indexOf(b?.source?.toLowerCase() ?? '_____FIXME_____');

			aPriority = aPriority === -1 ? Number.MAX_VALUE : aPriority;
			bPriority = bPriority === -1 ? Number.MAX_VALUE : bPriority;

			return aPriority - bPriority;
		})
		.sort((_, b) => (b.last_model_update?.Model?.playback?.status === 'Playing' ? 1 : -1));

	return orderedMedia;
};

// Insert/replace a session record, evicting any OTHER tracked session that shares its (non-empty)
// `source`. The store is keyed by `session_id`, but the now-playing widget selects by SOURCE — so a
// player that tears down and recreates its SMTC session (a NEW session_id for the same source, with
// no matching `session_delete`) would otherwise leave the stale record behind forever. Each record
// can carry an album-art thumbnail as a raw byte array, so those orphans accumulate into an unbounded
// heap leak — the overlay OOMs after hours of playback. Dropping same-source duplicates bounds the
// store to one live record per player. A record with no source can't be deduped, so it's upserted
// as-is. Pure (returns a new map). See [[priority]] sibling selectors.
export const upsertSession = (
	sessions: Record<number, SessionRecord>,
	record: SessionRecord
): Record<number, SessionRecord> => {
	const src = record.source;
	const next: Record<number, SessionRecord> = {};
	for (const [id, rec] of Object.entries(sessions)) {
		if (Number(id) === record.session_id) continue; // replaced below
		if (src && rec?.source === src) continue; // stale session for the same player → evict
		next[Number(id)] = rec;
	}
	next[record.session_id] = record;
	return next;
};

// Carry the previous record's media (title/artist/album + album-art bytes) forward when an update
// omits it. The backend strips the unchanged `last_media_update` on model/timeline (play/pause/seek)
// updates so the cover bytes aren't re-shipped over IPC every tick; this restores them from the prior
// record by session_id so the cover and metadata persist. A real media update (non-null
// `last_media_update`) replaces it as usual, and a first-seen session has nothing to carry. Pure.
export const mergeMediaForward = (
	prev: SessionRecord | undefined,
	incoming: SessionRecord
): SessionRecord =>
	prev && incoming.last_media_update == null
		? { ...incoming, last_media_update: prev.last_media_update }
		: incoming;

// Total bytes of album art referenced across all tracked sessions. The cover bytes no longer cross
// the bridge — they're served from the backend `art` registry (art.rs) — so each record carries only
// the retained byte count (`last_media_update.Media[1].bytes`). Summing them is the headline number
// for the studio Diagnostics panel: a climbing total still fingerprints a session-record leak (orphan
// records pile up references), now measuring backend retention rather than frontend heap. Pure.
export const sumArtBytes = (sessions: Record<number, SessionRecord>): number => {
	let total = 0;
	for (const rec of Object.values(sessions)) {
		const bytes = rec?.last_media_update?.Media?.[1]?.bytes;
		if (typeof bytes === 'number') total += bytes;
	}
	return total;
};
