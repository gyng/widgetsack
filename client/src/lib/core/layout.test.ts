import { describe, expect, it } from 'vitest';
import { DEFAULT_MONITOR, defaultLayout, parseLayout } from './layout';

const widget = {
	id: 'cpu-1',
	type: 'gauge',
	sensor: 'cpu.total',
	rect: { x: 0, y: 0, w: 100, h: 100 },
	config: {}
};

describe('defaultLayout', () => {
	it('has the current version and an empty default monitor', () => {
		const l = defaultLayout();
		expect(l.version).toBe(1);
		expect(l.monitors[DEFAULT_MONITOR].widgets).toEqual([]);
	});
});

describe('parseLayout', () => {
	it('parses a valid layout', () => {
		const parsed = parseLayout({ version: 1, monitors: { default: { widgets: [widget] } } });
		expect(parsed?.monitors.default.widgets).toHaveLength(1);
		expect(parsed?.monitors.default.widgets[0].id).toBe('cpu-1');
	});

	it('returns null for non-objects or a missing version/monitors', () => {
		expect(parseLayout(null)).toBeNull();
		expect(parseLayout('nope')).toBeNull();
		expect(parseLayout({ monitors: {} })).toBeNull();
		expect(parseLayout({ version: 1 })).toBeNull();
	});

	it('returns null when a monitor lacks a widgets array', () => {
		expect(parseLayout({ version: 1, monitors: { default: {} } })).toBeNull();
	});

	it('returns null when a monitor entry is not an object', () => {
		expect(parseLayout({ version: 1, monitors: { default: 'nope' } })).toBeNull();
		expect(parseLayout({ version: 1, monitors: { default: null } })).toBeNull();
	});

	it('drops malformed widgets but keeps valid ones', () => {
		const parsed = parseLayout({
			version: 1,
			monitors: { default: { widgets: [widget, { id: 'bad' }, 42] } }
		});
		expect(parsed?.monitors.default.widgets).toHaveLength(1);
	});
});

// createWidget moved to ./widget.ts (the standard widget API, 8a) — see widget.test.ts.
