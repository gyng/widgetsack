import { describe, expect, it } from 'vitest';
import {
	displaySensorValue,
	filterSensorIds,
	formatSensorValue,
	groupSensorIds,
	SYSTEM_GROUP
} from './sensorList';

describe('formatSensorValue', () => {
	it('renders a dash for no value', () => {
		expect(formatSensorValue(null)).toBe('—');
	});

	it('renders integers plainly and floats to 2dp', () => {
		expect(formatSensorValue({ kind: 'scalar', value: 42 })).toBe('42');
		expect(formatSensorValue({ kind: 'scalar', value: 3.14159 })).toBe('3.14');
	});

	it('renders text as-is', () => {
		expect(formatSensorValue({ kind: 'text', value: 'playing' })).toBe('playing');
	});

	it('renders the last point of a series with an ellipsis', () => {
		expect(formatSensorValue({ kind: 'series', value: [1, 2, 3] })).toBe('3 ⋯');
		expect(formatSensorValue({ kind: 'series', value: [] })).toBe('[ ]');
	});

	it('renders a non-integer last point to 1dp', () => {
		expect(formatSensorValue({ kind: 'series', value: [1, 2, 3.14159] })).toBe('3.1 ⋯');
	});

	it('renders json compactly (truncated)', () => {
		expect(formatSensorValue({ kind: 'json', value: { a: 1 } })).toBe('{"a":1}');
	});
});

describe('displaySensorValue', () => {
	it('formats scalars in their natural unit using the sensor id', () => {
		expect(displaySensorValue('mem.total', { kind: 'scalar', value: 17179869184 })).toBe(
			'16.0 GiB'
		);
		expect(displaySensorValue('net.down', { kind: 'scalar', value: 2048 })).toBe('2.0 KiB/s');
		expect(displaySensorValue('host.uptime', { kind: 'scalar', value: 90061 })).toBe('1d 1h');
		expect(displaySensorValue('cpu.total', { kind: 'scalar', value: 42 })).toBe('42%');
	});

	it('falls back to the plain renderer for text/series and null', () => {
		expect(displaySensorValue('cpu.brand', { kind: 'text', value: 'Ryzen' })).toBe('Ryzen');
		expect(displaySensorValue('mem.total', null)).toBe('—');
	});
});

describe('filterSensorIds', () => {
	const ids = ['cpu.total', 'cpu.core.0', 'mem.used', 'ha.light.kitchen'];

	it('returns all ids for an empty/whitespace query', () => {
		expect(filterSensorIds(ids, '')).toEqual(ids);
		expect(filterSensorIds(ids, '   ')).toEqual(ids);
	});

	it('matches a case-insensitive substring of the id', () => {
		expect(filterSensorIds(ids, 'cpu')).toEqual(['cpu.total', 'cpu.core.0']);
		expect(filterSensorIds(ids, 'KITCHEN')).toEqual(['ha.light.kitchen']);
		expect(filterSensorIds(ids, '.used')).toEqual(['mem.used']);
	});

	it('returns [] when nothing matches', () => {
		expect(filterSensorIds(ids, 'gpu')).toEqual([]);
	});
});

describe('groupSensorIds', () => {
	const groupFor = (id: string) =>
		id.startsWith('ha.') ? 'Home Assistant' : id.startsWith('mqtt.') ? 'MQTT' : SYSTEM_GROUP;

	it('buckets by label, system group first, plugin groups in first-appearance order', () => {
		const ids = ['ha.x', 'cpu.total', 'mqtt.y', 'cpu.core.0', 'ha.z'];
		const groups = groupSensorIds(ids, groupFor);
		expect(groups.map((g) => g.label)).toEqual([SYSTEM_GROUP, 'Home Assistant', 'MQTT']);
		expect(groups[0].ids).toEqual(['cpu.total', 'cpu.core.0']);
		expect(groups[1].ids).toEqual(['ha.x', 'ha.z']);
		expect(groups[2].ids).toEqual(['mqtt.y']);
	});

	it('returns [] for no ids', () => {
		expect(groupSensorIds([], () => SYSTEM_GROUP)).toEqual([]);
	});
});
