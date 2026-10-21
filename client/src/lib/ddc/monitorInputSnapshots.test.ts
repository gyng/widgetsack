import { beforeEach, expect, it, vi } from 'vitest';
import { readMonitorInputSnapshot, saveMonitorInputSnapshot } from './monitorInputSnapshots';
const record = {
	gdi: 'display',
	stable: 'desk',
	friendly: 'Desk',
	primary: true,
	current_input: 17,
	supported: [15, 17],
	width: 2560,
	height: 1440,
	refresh_hz: 144
};
const key = 'widgetsack.monitor-inputs.v1:desk';
beforeEach(() => localStorage.clear());
it('restores durable target-specific data without an in-memory cache', () => {
	saveMonitorInputSnapshot('desk', record);
	expect(readMonitorInputSnapshot('desk')).toEqual(record);
	expect(readMonitorInputSnapshot('other')).toBeNull();
	saveMonitorInputSnapshot('desk', { ...record, current_input: null });
	expect(readMonitorInputSnapshot('desk')?.current_input).toBeNull();
});
it('ignores malformed or incompatible persisted responses', () => {
	for (const value of [
		null,
		[],
		{},
		false,
		{ ...record, gdi: 5 },
		{ ...record, stable: 5 },
		{ ...record, friendly: null },
		{ ...record, primary: 1 },
		{ ...record, current_input: -1 },
		{ ...record, current_input: 256 },
		{ ...record, current_input: 1.5 },
		{ ...record, supported: null },
		{ ...record, supported: [17, 'bad'] },
		{ ...record, width: -1 },
		{ ...record, height: '1440' },
		{ ...record, refresh_hz: null }
	]) {
		localStorage.setItem(key, JSON.stringify(value));
		expect(readMonitorInputSnapshot('desk')).toBeNull();
	}
	localStorage.setItem(key, 'broken');
	expect(readMonitorInputSnapshot('desk')).toBeNull();
});
it('keeps live switching usable when storage is unavailable', () => {
	const read = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
		throw Error('blocked');
	});
	const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
		throw Error('full');
	});
	try {
		expect(readMonitorInputSnapshot('desk')).toBeNull();
		expect(() => saveMonitorInputSnapshot('desk', record)).not.toThrow();
	} finally {
		read.mockRestore();
		write.mockRestore();
	}
});
