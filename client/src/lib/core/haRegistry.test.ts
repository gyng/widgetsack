import { describe, expect, it } from 'vitest';
import { buildRegistryTree, type HaRegistry, type LiveState } from './haRegistry';

const reg = (over: Partial<HaRegistry> = {}): HaRegistry => ({
	areas: [],
	devices: [],
	entities: [],
	...over
});

// A device-less entity assigned straight to an area (for the area-ordering tests).
const ent = (id: string, area: string) => ({
	entity_id: id,
	device_id: null,
	area_id: area,
	name: null,
	original_name: id,
	platform: 'p'
});

describe('buildRegistryTree', () => {
	it('groups an entity under its device within the device area (inherited area)', () => {
		const tree = buildRegistryTree(
			reg({
				areas: [{ area_id: 'living', name: 'Living Room' }],
				devices: [{ id: 'd1', name: 'Lamp', area_id: 'living', manufacturer: null, model: null }],
				entities: [
					{
						entity_id: 'light.lamp',
						device_id: 'd1',
						area_id: null,
						name: null,
						original_name: 'Lamp',
						platform: 'hue'
					}
				]
			}),
			{}
		);
		expect(tree).toHaveLength(1);
		expect(tree[0].name).toBe('Living Room');
		expect(tree[0].devices).toHaveLength(1);
		expect(tree[0].devices[0].name).toBe('Lamp');
		expect(tree[0].devices[0].entities[0].sensorId).toBe('ha.light.lamp');
		expect(tree[0].looseEntities).toHaveLength(0);
	});

	it('an explicit entity area override detaches it from its device into that area (loose)', () => {
		const tree = buildRegistryTree(
			reg({
				areas: [
					{ area_id: 'living', name: 'Living Room' },
					{ area_id: 'office', name: 'Office' }
				],
				devices: [{ id: 'd1', name: 'Hub', area_id: 'living', manufacturer: null, model: null }],
				entities: [
					{
						entity_id: 'sensor.x',
						device_id: 'd1',
						area_id: 'office', // override
						name: null,
						original_name: 'X',
						platform: 'p'
					}
				]
			}),
			{}
		);
		const office = tree.find((a) => a.name === 'Office');
		expect(office?.looseEntities.map((e) => e.entityId)).toEqual(['sensor.x']);
		// The Living Room area has no entities, so it is omitted entirely.
		expect(tree.find((a) => a.name === 'Living Room')).toBeUndefined();
	});

	it('entities with no area land in the Unassigned bucket, listed last', () => {
		const tree = buildRegistryTree(
			reg({
				areas: [{ area_id: 'k', name: 'Kitchen' }],
				devices: [],
				entities: [
					{
						entity_id: 'sensor.orphan',
						device_id: null,
						area_id: null,
						name: null,
						original_name: 'Orphan',
						platform: 'p'
					},
					{
						entity_id: 'sensor.kit',
						device_id: null,
						area_id: 'k',
						name: null,
						original_name: 'Kit',
						platform: 'p'
					}
				]
			}),
			{}
		);
		expect(tree.map((a) => a.name)).toEqual(['Kitchen', 'Unassigned']); // named first, Unassigned last
		expect(tree[1].areaId).toBeNull();
		expect(tree[1].looseEntities[0].entityId).toBe('sensor.orphan');
	});

	it('applies display-name precedence: name ?? live.friendly_name ?? original_name ?? id', () => {
		const live: Record<string, LiveState> = {
			'sensor.a': { friendly_name: 'Live A', state: '21', unit: '°C' },
			'sensor.b': { state: 'on' }
		};
		const tree = buildRegistryTree(
			reg({
				entities: [
					{
						entity_id: 'sensor.a',
						device_id: null,
						area_id: null,
						name: null,
						original_name: 'Orig A',
						platform: 'p'
					}, // → live friendly_name wins over original_name
					{
						entity_id: 'sensor.b',
						device_id: null,
						area_id: null,
						name: 'Override B',
						original_name: 'Orig B',
						platform: 'p'
					}, // → registry name wins
					{
						entity_id: 'sensor.c',
						device_id: null,
						area_id: null,
						name: null,
						original_name: null,
						platform: 'p'
					} // → falls back to entity_id
				]
			}),
			live
		);
		const loose = tree[0].looseEntities;
		const byId = Object.fromEntries(loose.map((e) => [e.entityId, e]));
		expect(byId['sensor.a'].name).toBe('Live A');
		expect(byId['sensor.a'].unit).toBe('°C');
		expect(byId['sensor.b'].name).toBe('Override B');
		expect(byId['sensor.c'].name).toBe('sensor.c');
	});

	it('falls back to the raw area_id for sorting/display when it has no matching area registry entry', () => {
		const tree = buildRegistryTree(
			reg({
				areas: [{ area_id: 'k', name: 'Kitchen' }],
				devices: [],
				entities: [
					{
						entity_id: 'sensor.ghost',
						device_id: null,
						area_id: 'ghost', // dangling: no matching entry in `areas`
						name: null,
						original_name: 'Ghost',
						platform: 'p'
					}
				]
			}),
			{}
		);
		const ghost = tree.find((a) => a.areaId === 'ghost');
		expect(ghost?.name).toBe('ghost'); // falls back to the raw id, not a friendly name
	});

	it('falls back to the raw device id as its display name when the device has no name', () => {
		const tree = buildRegistryTree(
			reg({
				devices: [{ id: 'd9', name: null, area_id: null, manufacturer: null, model: null }],
				entities: [
					{
						entity_id: 'switch.s',
						device_id: 'd9',
						area_id: null,
						name: null,
						original_name: 'S',
						platform: 'p'
					}
				]
			}),
			{}
		);
		expect(tree[0].devices[0].name).toBe('d9');
	});

	it('sorts several named areas alphabetically by friendly name, dangling ids by raw id', () => {
		const tree = buildRegistryTree(
			reg({
				areas: [
					{ area_id: 'k', name: 'Kitchen' },
					{ area_id: 'b', name: 'Bedroom' }
				],
				devices: [],
				entities: [ent('sensor.k', 'k'), ent('sensor.b', 'b'), ent('sensor.g', 'attic')]
			}),
			{}
		);
		// 'attic' has no registry entry so it sorts by its raw id, ahead of the friendly names.
		expect(tree.map((a) => a.name)).toEqual(['attic', 'Bedroom', 'Kitchen']);
	});

	it('orders two dangling area ids against each other by raw id', () => {
		const tree = buildRegistryTree(
			reg({ entities: [ent('sensor.z', 'zeta'), ent('sensor.a', 'alpha')] }),
			{}
		);
		expect(tree.map((a) => a.name)).toEqual(['alpha', 'zeta']);
	});

	it('groups a device with no area under Unassigned', () => {
		const tree = buildRegistryTree(
			reg({
				devices: [{ id: 'd9', name: 'Floating', area_id: null, manufacturer: null, model: null }],
				entities: [
					{
						entity_id: 'switch.s',
						device_id: 'd9',
						area_id: null,
						name: null,
						original_name: 'S',
						platform: 'p'
					}
				]
			}),
			{}
		);
		expect(tree).toHaveLength(1);
		expect(tree[0].areaId).toBeNull();
		expect(tree[0].devices[0].name).toBe('Floating');
	});
});
