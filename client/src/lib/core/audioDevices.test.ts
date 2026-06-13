import { describe, it, expect } from 'vitest';
import { audioDeviceRows } from './audioDevices';

describe('audioDeviceRows', () => {
	const devices = [
		{ id: 'a', name: 'Speakers' },
		{ id: 'b', name: 'Headphones' },
		{ id: 'c', name: 'HDMI' }
	];

	it('marks the current default and floats it first', () => {
		const rows = audioDeviceRows(devices, 'b');
		expect(rows[0]).toEqual({ id: 'b', name: 'Headphones', active: true });
		expect(rows.filter((r) => r.active)).toHaveLength(1);
		expect(rows.map((r) => r.id)).toEqual(['b', 'a', 'c']);
	});

	it('marks none active when the default is unknown', () => {
		const rows = audioDeviceRows(devices, null);
		expect(rows.every((r) => !r.active)).toBe(true);
		expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']); // order preserved
	});
});
