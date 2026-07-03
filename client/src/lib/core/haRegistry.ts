// Pure builder of the Home Assistant area > device > entity tree from the three registries
// (config/*_registry/list) joined with the live state. Framework-agnostic domain (AGENTS.md §5):
// no React/Tauri — registry + state in, tree out — so the join rules are unit-tested directly.
//
// Join rules (per the HA frontend):
//   - An entity's effective area = entity.area_id ?? its device's area_id ?? none ("Unassigned").
//   - An entity groups UNDER its device only when it inherits the area (no explicit entity area_id);
//     an explicit area override detaches it from the device into that area as a loose entity.
//   - Display name precedence: entity.name ?? live.friendly_name ?? entity.original_name ?? entity_id.
//   - device_class/unit/friendly_name/state come from the LIVE state, not the registry.

// Bridge-mirror row types (from widgetsack/src/ha.rs HaArea/HaDevice/HaEntityReg). They live here
// in the domain ring (the outer ha-types.ts re-exports them) so this pure builder imports nothing
// from the widgets layer. Structure + names only.
export type HaArea = { area_id: string; name: string };
export type HaDevice = {
	id: string;
	name: string | null;
	area_id: string | null;
	manufacturer: string | null;
	model: string | null;
};
export type HaEntityReg = {
	entity_id: string;
	device_id: string | null;
	area_id: string | null;
	name: string | null;
	original_name: string | null;
	platform: string | null;
};
export type HaRegistry = { areas: HaArea[]; devices: HaDevice[]; entities: HaEntityReg[] };

/** Per-entity live values keyed by entity_id (projected from HaEntity / `/api/states`). */
export type LiveState = { state?: string; friendly_name?: string; unit?: string };

export type TreeEntity = {
	entityId: string;
	sensorId: string; // `ha.<entity_id>` — the bindable id
	name: string;
	state?: string;
	unit?: string;
};
export type TreeDevice = { id: string; name: string; entities: TreeEntity[] };
export type TreeArea = {
	areaId: string | null; // null = the synthetic "Unassigned" bucket
	name: string;
	devices: TreeDevice[];
	looseEntities: TreeEntity[]; // entities in the area with no (in-area) device
};

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

export function buildRegistryTree(reg: HaRegistry, live: Record<string, LiveState>): TreeArea[] {
	const deviceById = new Map(reg.devices.map((d) => [d.id, d]));
	const areaName = new Map(reg.areas.map((a) => [a.area_id, a.name]));

	const displayName = (e: HaEntityReg): string =>
		e.name ?? live[e.entity_id]?.friendly_name ?? e.original_name ?? e.entity_id;
	const toTreeEntity = (e: HaEntityReg): TreeEntity => ({
		entityId: e.entity_id,
		sensorId: `ha.${e.entity_id}`,
		name: displayName(e),
		state: live[e.entity_id]?.state,
		unit: live[e.entity_id]?.unit
	});

	type Bucket = { deviceEntities: Map<string, HaEntityReg[]>; loose: HaEntityReg[] };
	const buckets = new Map<string, Bucket>(); // key: area_id, or '' for Unassigned
	const bucket = (key: string): Bucket => {
		let b = buckets.get(key);
		if (!b) {
			b = { deviceEntities: new Map(), loose: [] };
			buckets.set(key, b);
		}
		return b;
	};

	for (const e of reg.entities) {
		const dev = e.device_id != null ? deviceById.get(e.device_id) : undefined;
		const inherits = e.area_id == null; // no explicit entity-level area override
		const effectiveArea = e.area_id ?? (inherits ? (dev?.area_id ?? null) : null);
		const b = bucket(effectiveArea ?? '');
		if (dev && inherits) {
			const list = b.deviceEntities.get(dev.id) ?? [];
			list.push(e);
			b.deviceEntities.set(dev.id, list);
		} else {
			b.loose.push(e);
		}
	}

	// Named areas first (alphabetical), the Unassigned bucket last.
	const namedKeys = Array.from(buckets.keys())
		.filter((k) => k !== '')
		.sort((a, b) => (areaName.get(a) ?? a).localeCompare(areaName.get(b) ?? b));
	const orderedKeys = [...namedKeys, ...(buckets.has('') ? [''] : [])];

	const out: TreeArea[] = [];
	for (const key of orderedKeys) {
		const b = buckets.get(key);
		if (!b) continue;
		const devices: TreeDevice[] = Array.from(b.deviceEntities.entries())
			.map(([id, ents]) => ({
				id,
				name: deviceById.get(id)?.name ?? id,
				entities: ents.map(toTreeEntity).sort(byName)
			}))
			.sort(byName);
		const looseEntities = b.loose.map(toTreeEntity).sort(byName);
		if (!devices.length && !looseEntities.length) continue;
		out.push({
			areaId: key === '' ? null : key,
			name: key === '' ? 'Unassigned' : (areaName.get(key) ?? key),
			devices,
			looseEntities
		});
	}
	return out;
}
