import { describe, expect, it } from 'vitest';
import type { MonitorLayout } from './layoutTree';
import { changedMonitorKeys, monitorPresence, planOverlays, type PlanMonitor } from './overlayPlan';

const STRIP = 'CRXED00-UID184576';
const ABOVE = 'DELD154-UID184579';
const FOURK = 'DEL428B-UID184577';

const mon = (key: string, primary = false): PlanMonitor => ({ key, primary });

describe('planOverlays', () => {
	it('creates an overlay for each populated non-primary monitor that has none', () => {
		const plan = planOverlays({
			monitors: [mon(FOURK, true), mon(STRIP), mon(ABOVE)],
			populated: new Set(['default', STRIP]),
			existingLabels: ['main']
		});
		expect(plan).toEqual({ create: [STRIP], close: [] });
	});

	it('keeps an overlay that is wanted and already open', () => {
		const plan = planOverlays({
			monitors: [mon(FOURK, true), mon(STRIP)],
			populated: new Set([STRIP]),
			existingLabels: ['main', `overlay-${STRIP}`]
		});
		expect(plan).toEqual({ create: [], close: [] });
	});

	it('closes an overlay whose monitor no longer has widgets', () => {
		const plan = planOverlays({
			monitors: [mon(FOURK, true), mon(STRIP)],
			populated: new Set(['default']),
			existingLabels: [`overlay-${STRIP}`]
		});
		expect(plan).toEqual({ create: [], close: [`overlay-${STRIP}`] });
	});

	it('closes an overlay whose monitor is no longer connected (HDMI switched away)', () => {
		// The strip's layout is still populated, but the strip is gone: Windows would otherwise
		// relocate that window onto another monitor, or leave it invisible holding a renderer.
		const plan = planOverlays({
			monitors: [mon(FOURK, true), mon(ABOVE)],
			populated: new Set([STRIP]),
			existingLabels: [`overlay-${STRIP}`]
		});
		expect(plan).toEqual({ create: [], close: [`overlay-${STRIP}`] });
	});

	it('closes the overlay of a monitor that has BECOME the primary (main covers it now)', () => {
		// The 4K switched away → Windows made the strip primary. `main` renders `default` there;
		// the strip's own overlay must not stack on top of it.
		const plan = planOverlays({
			monitors: [mon(STRIP, true), mon(ABOVE)],
			populated: new Set([STRIP, 'default']),
			existingLabels: ['main', `overlay-${STRIP}`]
		});
		expect(plan).toEqual({ create: [], close: [`overlay-${STRIP}`] });
	});

	it('closes legacy-labelled windows (index era, GDI-tag era) alongside their stable successor', () => {
		const plan = planOverlays({
			monitors: [mon(FOURK, true), mon(STRIP)],
			populated: new Set([STRIP]),
			existingLabels: ['overlay-2', 'overlay-DISPLAY3', `overlay-${STRIP}`]
		});
		expect(plan).toEqual({ create: [], close: ['overlay-2', 'overlay-DISPLAY3'] });
	});

	it('never touches non-overlay windows', () => {
		const plan = planOverlays({
			monitors: [mon(FOURK, true)],
			populated: new Set(),
			existingLabels: ['main', 'studio', 'overlay-settings-x']
		});
		expect(plan).toEqual({ create: [], close: ['overlay-settings-x'] });
	});

	it('keeps the window of an unknown (damaged) key but still reconciles the others', () => {
		// The strip's record could not be parsed (hand edit / downgrade): we can't tell whether it
		// holds widgets, so its window stays — but the readable monitors are still reconciled.
		const plan = planOverlays({
			monitors: [mon(FOURK, true), mon(STRIP), mon(ABOVE)],
			populated: new Set([ABOVE]),
			unknown: new Set([STRIP]),
			existingLabels: ['main', `overlay-${STRIP}`, 'overlay-2']
		});
		expect(plan).toEqual({ create: [ABOVE], close: ['overlay-2'] });
	});

	it('closes the window of an unknown key once its monitor is disconnected', () => {
		const plan = planOverlays({
			monitors: [mon(FOURK, true)],
			populated: new Set(),
			unknown: new Set([STRIP]),
			existingLabels: ['main', `overlay-${STRIP}`]
		});
		expect(plan).toEqual({ create: [], close: [`overlay-${STRIP}`] });
	});

	it('never creates a window for an unknown key', () => {
		const plan = planOverlays({
			monitors: [mon(FOURK, true), mon(STRIP)],
			populated: new Set(),
			unknown: new Set([STRIP]),
			existingLabels: ['main']
		});
		expect(plan).toEqual({ create: [], close: [] });
	});
});

const empty = (): MonitorLayout => ({
	root: { id: 'r', kind: 'row', children: [] },
	floating: []
});
const filled = (): MonitorLayout => ({
	...empty(),
	floating: [
		{ id: 'l', unit: { id: 'w', type: 'clock', rect: { x: 0, y: 0, w: 10, h: 10 }, config: {} } }
	]
});

describe('monitorPresence', () => {
	it('splits parsed monitors into populated keys and raw keys that failed to parse', () => {
		const presence = monitorPresence(['default', STRIP, ABOVE, 'bad'], {
			default: filled(),
			[STRIP]: empty(),
			[ABOVE]: filled()
		});
		expect(presence).toEqual({
			populated: new Set(['default', ABOVE]),
			unknown: new Set(['bad'])
		});
	});
});

describe('changedMonitorKeys', () => {
	it('names the renamed-away legacy keys and their new keys, not untouched ones', () => {
		const a = {};
		const b = {};
		expect(changedMonitorKeys({ default: a, '1': b }, { default: a, [STRIP]: b }).sort()).toEqual(
			['1', STRIP].sort()
		);
		expect(changedMonitorKeys({ default: a }, { default: b })).toEqual(['default']);
	});
});
