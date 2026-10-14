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
	const rank = new Map(
		sourcePriority
			.split('\n')
			.map((source) => source.trim().toLowerCase())
			.filter(Boolean)
			.map((source, index) => [source, index])
	);
	const priorityOf = (session: SessionRecord): number =>
		rank.get(session.source?.toLowerCase() ?? '') ?? Number.MAX_SAFE_INTEGER;
	const playingOf = (session: SessionRecord): number =>
		session.last_model_update?.Model?.playback?.status === 'Playing' ? 0 : 1;

	return Object.values(currentSessions).sort((a, b) => {
		const playing = playingOf(a) - playingOf(b);
		if (playing !== 0) return playing;
		const priority = priorityOf(a) - priorityOf(b);
		if (priority !== 0) return priority;
		const aTime = a.timestamp_updated;
		const bTime = b.timestamp_updated;
		const seconds = (bTime?.secs_since_epoch ?? 0) - (aTime?.secs_since_epoch ?? 0);
		if (seconds !== 0) return seconds;
		const nanos = (bTime?.nanos_since_epoch ?? 0) - (aTime?.nanos_since_epoch ?? 0);
		return nanos !== 0 ? nanos : a.session_id - b.session_id;
	});
};

// Insert/replace a session record, keeping at most MAX_SESSIONS_PER_SOURCE records that share its
// (non-empty) `source`. A player that tears down and recreates its SMTC session (a NEW session_id for
// the same source, with no matching `session_delete`) would otherwise leave stale records behind
// forever — an unbounded leak that once OOMed the overlay after hours of playback. One record per
// source was too few: a browser exposes a live session per tab under one source, and evicting a tab
// left now-playing blank. A record with no source can't be grouped, so it's upserted as-is. Pure
// (returns a new map). See [[priority]] sibling selectors.
export const MAX_SESSIONS_PER_SOURCE = 4;

export const upsertSession = (
	sessions: Record<number, SessionRecord>,
	record: SessionRecord
): Record<number, SessionRecord> => {
	const src = record.source;
	const next: Record<number, SessionRecord> = { ...sessions, [record.session_id]: record };
	if (!src) return next;
	// Several live sessions can share a source (one per browser tab), so keep the newest few per
	// player rather than one. win-gsmtc ids increase, so the lowest ids are the oldest.
	const sameSource = Object.values(next)
		.filter((rec) => rec?.source === src)
		.map((rec) => rec.session_id)
		.sort((a, b) => b - a);
	for (const id of sameSource.slice(MAX_SESSIONS_PER_SOURCE)) delete next[id];
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
