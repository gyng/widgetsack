// The data-source half of the plugin API (Phase 8b). A `SensorSource` feeds the
// telemetry hub (the built-in `system` source pipes the Rust `telemetry` event; a plugin
// like Home Assistant adds another). Sources are framework-agnostic — they only touch the
// hub — so this lives in core/. The full `Plugin` (widgets need Svelte components) is
// assembled in widgets/plugin.ts. Co-located vitest tests in plugin.test.ts.

import type { TelemetryHub } from './telemetry';

/** A catalog entry with optional display metadata, so the inspector dropdown can show a friendly
 * label + unit instead of a bare id (e.g. `ha.light.kitchen` → "Kitchen Light"). The `id` is the
 * value a widget binds to; `label`/`unit` are presentation only. */
export type SensorCatalogEntry = { id: string; label?: string; unit?: string };

export type SensorSource = {
	id: string;
	/** Connect + start ingesting into `hub`; resolve to an unsubscribe/stop function. */
	start(hub: TelemetryHub): Promise<() => void>;
	/** Sensor ids this source provides, for the inspector's sensor dropdown (optional). */
	catalog?: () => string[];
	/** Richer catalog with display metadata (optional). Sources that implement this drive the
	 * friendly-labelled dropdown; sources with only `catalog()` fall back to bare-id entries. */
	catalogEntries?: () => SensorCatalogEntry[];
};

const sources = new Map<string, SensorSource>();

/** Register (or replace) a sensor source by id. */
export function registerSource(source: SensorSource): void {
	sources.set(source.id, source);
}

/** Drop a source by id (no-op when absent) — its catalog entries vanish from the next
 * `sourceCatalogEntries()` read. Used by toggleable sources (third-party packages); built-ins
 * never unregister. Does NOT stop a started source — the registrant owns that lifecycle. */
export function unregisterSource(id: string): void {
	sources.delete(id);
}

export function listSources(): SensorSource[] {
	return Array.from(sources.values());
}

/** Start every registered source against `hub`; returns a single stop-all function.
 * Each source starts independently: one source that fails to start (e.g. an unreachable
 * Home Assistant) is logged and skipped rather than rejecting — a failed data source must
 * not abort app init, which now gates the (born-hidden) overlay's first reveal. */
export async function startAllSources(hub: TelemetryHub): Promise<() => void> {
	const results = await Promise.all(
		listSources().map(async (s) => {
			try {
				const stop = await s.start(hub);
				return () => {
					try {
						stop();
					} catch (err) {
						console.warn(`source "${s.id}" failed to stop`, err);
					}
				};
			} catch (err) {
				console.warn(`source "${s.id}" failed to start`, err);
				return () => undefined;
			}
		})
	);
	return () => results.forEach((u) => u());
}

/** The union of every source's catalog ids (deduped), for the sensor dropdown. */
export function sourceCatalogIds(): string[] {
	const out = new Set<string>();
	for (const s of listSources()) for (const id of s.catalog?.() ?? []) out.add(id);
	return Array.from(out);
}

/** The union of every source's catalog ENTRIES (first id wins on collision), for the friendly
 * dropdown. A source with only `catalog()` contributes bare-id entries, so this is a superset-safe
 * replacement for `sourceCatalogIds` when display metadata is wanted. */
export function sourceCatalogEntries(): SensorCatalogEntry[] {
	const byId = new Map<string, SensorCatalogEntry>();
	for (const s of listSources()) {
		const entries = s.catalogEntries?.() ?? (s.catalog?.() ?? []).map((id) => ({ id }));
		for (const e of entries) if (!byId.has(e.id)) byId.set(e.id, e);
	}
	return Array.from(byId.values());
}
