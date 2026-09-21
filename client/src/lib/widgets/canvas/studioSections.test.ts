import { describe, expect, it } from 'vitest';
import { RAIL_ORDER, SECTIONS } from './studioSections';

describe('studio nav SECTIONS', () => {
	it('lists the sections top-down in the intended order', () => {
		expect(SECTIONS.map((s) => s.id)).toEqual([
			'layouts',
			'widget-designer',
			'sensors',
			'plugins',
			'themes',
			'background',
			'sacks',
			'saved-layouts',
			'settings'
		]);
	});

	it('puts Settings in the foot group (the <gap> before it)', () => {
		expect(SECTIONS.filter((s) => s.group === 'foot').map((s) => s.id)).toEqual(['settings']);
	});

	it('has unique ids and a non-empty icon + short label for each', () => {
		expect(new Set(SECTIONS.map((s) => s.id)).size).toBe(SECTIONS.length);
		for (const s of SECTIONS) {
			expect(s.icon).toBeTruthy();
			expect(s.short).toBeTruthy();
		}
	});

	it('uses the shared vocabulary for the user-facing labels (ids stay stable for e2e)', () => {
		const byId = Object.fromEntries(SECTIONS.map((s) => [s.id, s]));
		expect(byId['layouts'].short).toBe('Layout');
		expect(byId['widget-designer']).toMatchObject({ label: 'Widget designer', short: 'Custom' });
		expect(byId['background']).toMatchObject({ label: 'Background', short: 'Background' });
		// Sacks are the user's own exports; the nav says "Share" and the tooltip explains the noun.
		expect(byId['sacks']).toMatchObject({
			label: 'Share',
			short: 'Share',
			title: 'Sacks — export/import'
		});
		expect(byId['saved-layouts']).toMatchObject({ label: 'Presets', short: 'Presets' });
		// The words that must NOT leak into the rail (renamed by the vocabulary sweep).
		for (const s of SECTIONS) {
			expect(`${s.label} ${s.short}`).not.toMatch(/(Defs|Backdrop|Saved layouts|Sacks)/);
		}
	});

	it('uses a distinct glyph per section (no overloaded icons)', () => {
		const icons = SECTIONS.map((s) => s.icon);
		expect(new Set(icons).size).toBe(icons.length);
	});

	it('keeps the nav glyphs off the in-canvas "copy" (⧉) and "container/grid" (▦) signifiers', () => {
		const icons = SECTIONS.map((s) => s.icon);
		expect(icons).not.toContain('⧉');
		expect(icons).not.toContain('▦');
	});
});

describe('RAIL_ORDER (keyboard section-jump order)', () => {
	it('matches the NavRail render order: the main group first, then the foot group', () => {
		const expected = [
			...SECTIONS.filter((s) => s.group === 'main'),
			...SECTIONS.filter((s) => s.group === 'foot')
		].map((s) => s.id);
		expect(RAIL_ORDER.map((s) => s.id)).toEqual(expected);
	});

	it('is a permutation of SECTIONS (every section reachable by Ctrl+1..8, none duplicated)', () => {
		expect(RAIL_ORDER).toHaveLength(SECTIONS.length);
		expect(new Set(RAIL_ORDER.map((s) => s.id))).toEqual(new Set(SECTIONS.map((s) => s.id)));
	});

	it('puts Settings last so its Ctrl+digit index is the bottom rail button', () => {
		expect(RAIL_ORDER[RAIL_ORDER.length - 1].id).toBe('settings');
	});
});
