import { describe, expect, it } from 'vitest';
import { compareMonitorOptions, monitorOptionLabel } from './monitorLabel';

describe('compareMonitorOptions', () => {
	it('puts the primary first, then natural device order (DISPLAY2 before DISPLAY10)', () => {
		const opts = [
			{ key: 'DISPLAY10', name: 'DISPLAY10' },
			{ key: 'DISPLAY2', name: 'DISPLAY2' },
			{ key: 'default', name: 'DISPLAY3' },
			{ key: 'DISPLAY1', name: 'DISPLAY1' }
		];
		expect(opts.sort(compareMonitorOptions).map((o) => o.key)).toEqual([
			'default',
			'DISPLAY1',
			'DISPLAY2',
			'DISPLAY10'
		]);
	});

	it('treats two "default" entries as equal', () => {
		expect(
			compareMonitorOptions({ key: 'default', name: 'A' }, { key: 'default', name: 'B' })
		).toBe(0);
	});
});

describe('monitorOptionLabel', () => {
	it('appends the friendly name after the device tag (and the primary marker) when known', () => {
		expect(
			monitorOptionLabel({
				device: 'DISPLAY1',
				friendly: 'Dell U2720Q',
				isPrimary: true,
				w: 2560,
				h: 1440,
				x: 0,
				y: 0
			})
		).toBe('DISPLAY1 — Dell U2720Q (primary) · 2560×1440 @ 0,0');
	});

	it('falls back to the device tag alone when the friendly name is unknown', () => {
		expect(
			monitorOptionLabel({
				device: 'DISPLAY2',
				friendly: '',
				isPrimary: false,
				w: 1920,
				h: 1080,
				x: 2560,
				y: 0
			})
		).toBe('DISPLAY2 · 1920×1080 @ 2560,0');
	});
});
