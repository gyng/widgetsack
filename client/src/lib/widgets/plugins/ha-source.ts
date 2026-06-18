// The Home Assistant data source (Phase 8c). HA is a Rust *proxy* source: the WebSocket
// and the long-lived token live server-side (widgetsack/src/ha.rs, plugins/ha.json), and
// entity state arrives over the EXISTING `telemetry` event as `ha.<entity_id>` samples —
// ingested by the built-in `system` source's listener, unchanged. So this source only
// flips the connection on/off and provides the entity catalog for the inspector dropdown;
// it never opens a socket or sees the token (the more-secure model, locked 2026-06-02).
//
// The catalog is curated by the user's "exposed" allowlist (ha-exposed-store): once any entity
// is exposed, only those surface in the dropdown; an empty allowlist shows everything (opt-in).

import type { SensorSource, SensorCatalogEntry } from '../../core/plugin';
import { curate } from '../../core/haExposed';
import { haConnect, haDisconnect, listHaEntities } from './ha-commands';
import { startHaBackfill } from './ha-backfill';
import type { HaEntity } from './ha-types';
import { haExposedStore } from './ha-exposed-store';

// Full entities cached from the last catalog fetch, so the dropdown can show friendly names +
// units synchronously alongside the live system sensors. The entity browser reads the same cache.
let cachedEntities: HaEntity[] = [];

const allEntries = (): SensorCatalogEntry[] =>
	cachedEntities.map((e) => ({
		id: `ha.${e.entity_id}`,
		label: e.friendly_name ?? e.entity_id,
		unit: e.unit
	}));

/** Re-fetch the entity catalog (used by the settings panel's Refresh, and at source start), so
 * entities added in HA after launch appear without a restart. Connects first (idempotent), then
 * caches the entities. Silent on failure (not configured / unreachable) — keeps the prior cache.
 * Returns the current cache so the browser can render it. */
export async function refreshHaCatalog(): Promise<HaEntity[]> {
	try {
		// Spawns the server-side WS task iff plugins/ha.json exists; a no-op otherwise.
		await haConnect();
		cachedEntities = await listHaEntities();
	} catch {
		// Not configured / unreachable: keep whatever we had. The user configures HA in the studio's
		// Plugins panel and refreshes to light them up.
	}
	return cachedEntities;
}

export const haSource: SensorSource = {
	id: 'home-assistant',
	start: async (hub) => {
		await refreshHaCatalog();
		// Backfill recent HA history into this window's hub so sparklines bound to HA entities aren't
		// blank on launch (reactive: fires as widgets subscribe). Order-stable ingest merges the
		// back-dated samples — see core/telemetry.ts + plugins/ha-backfill.ts.
		const stopBackfill = startHaBackfill(hub);
		return () => {
			stopBackfill();
			haDisconnect().catch(() => undefined);
		};
	},
	catalog: () => curate(allEntries(), (e) => e.id, haExposedStore.getSnapshot()).map((e) => e.id),
	catalogEntries: () => curate(allEntries(), (e) => e.id, haExposedStore.getSnapshot())
};
