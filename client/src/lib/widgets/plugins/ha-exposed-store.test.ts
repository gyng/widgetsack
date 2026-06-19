// The HA "exposed" allowlist persistence adapter. The store is seeded once at module load by
// parsing localStorage at the legacy key 'ha.exposed'; the pure normalize logic lives (and is
// tested) in core/haExposed. Here we cover the adapter's own `parse` seam — both the array and
// the non-array (corrupt / missing) branches — by seeding storage and re-importing the module so
// its module-level createPersistedStore runs the parse, plus the write-through on update.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'ha.exposed';

async function loadWith(raw: string | null) {
	if (raw === null) localStorage.removeItem(KEY);
	else localStorage.setItem(KEY, raw);
	vi.resetModules();
	return import('./ha-exposed-store');
}

beforeEach(() => {
	localStorage.removeItem(KEY);
	vi.resetModules();
});

afterEach(() => {
	localStorage.removeItem(KEY);
	vi.resetModules();
});

describe('haExposedStore', () => {
	it('parses a stored string array: de-dupes, trims, drops empties, and sorts', async () => {
		const { haExposedStore } = await loadWith(
			JSON.stringify(['ha.light.b', '  ha.light.a  ', '', 'ha.light.b', 42, null])
		);
		// Non-string entries are filtered out before normalizeExposed runs.
		expect(haExposedStore.getSnapshot()).toEqual(['ha.light.a', 'ha.light.b']);
	});

	it('falls back to an empty list when the stored value is not an array', async () => {
		const { haExposedStore } = await loadWith(JSON.stringify({ not: 'an array' }));
		expect(haExposedStore.getSnapshot()).toEqual([]);
	});

	it('falls back to an empty list when nothing is stored', async () => {
		const { haExposedStore } = await loadWith(null);
		expect(haExposedStore.getSnapshot()).toEqual([]);
	});

	it('persists updates back to the legacy key', async () => {
		const { haExposedStore } = await loadWith(null);
		haExposedStore.set(['ha.switch.fan']);
		expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['ha.switch.fan']);
	});
});
