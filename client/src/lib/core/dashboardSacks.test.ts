import { describe, expect, it } from 'vitest';
import { DASHBOARD_SACKS } from './dashboardSacks';
import { unpackSack, mergeLibrary } from './sack';
import { isContainer } from './layoutTree';
describe('dashboard sacks', () => {
	it('ships five importable reusable dashboards with unique IDs and coherent dimensions', () => {
		expect(Object.keys(DASHBOARD_SACKS)).toEqual([
			'Built-in: Local desktop',
			'Built-in: Work',
			'Built-in: Gaming',
			'Built-in: Home',
			'Built-in: Minimal'
		]);
		for (const sack of Object.values(DASHBOARD_SACKS)) {
			expect(unpackSack(JSON.stringify(sack))).toEqual(sack);
			const def = sack.library!.defs[0];
			expect(def.size.w).toBeGreaterThan(360);
			expect(isContainer(def.child)).toBe(true);
			if (!isContainer(def.child)) throw new Error('dashboard must be a flow container');
			expect(new Set(def.child.children.map((c) => c.id)).size).toBe(def.child.children.length);
			const merged = mergeLibrary(sack.library, sack.library!.defs);
			expect(merged.library.defs).toHaveLength(2);
			expect(merged.library.defs[1].id).not.toBe(def.id);
		}
	});
});
