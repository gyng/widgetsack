// Pure parsing for the RSS widget. No React/Tauri — unit-tested. Mirrors the `FeedItem` rows the Rust
// rss.rs emits as the `rss.list` JSON sensor; this just defensively shapes them for the list meter.

/** One headline. Mirrors Rust `FeedItem` (widgetsack/src/rss.rs). */
export type FeedItem = { title: string; link: string };

/** Defensively parse the `rss.list` JSON sensor value into typed items (malformed entries dropped). */
export function parseRssList(value: unknown): FeedItem[] {
	if (!Array.isArray(value)) return [];
	const out: FeedItem[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') continue;
		const r = raw as Record<string, unknown>;
		if (typeof r.title !== 'string' || !r.title) continue;
		out.push({ title: r.title, link: typeof r.link === 'string' ? r.link : '' });
	}
	return out;
}
