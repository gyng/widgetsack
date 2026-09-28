import { describe, expect, it } from 'vitest';
import { emptyMonitorLayout, container, type Library } from './layoutTree';
import {
	planLayoutSave,
	planLayoutRevert,
	type PersistView,
	type LayoutFile,
	type Baseline
} from './layoutPersistence';

const baseline = (): Baseline => ({
	monitor: emptyMonitorLayout(),
	library: undefined,
	theme: '',
	themeLock: true,
	tokens: {}
});
const view = (): PersistView => ({
	myMonitor: 'a',
	monitor: emptyMonitorLayout(),
	library: undefined,
	selectedTheme: '',
	themeLock: true,
	globalTheme: '',
	tokenOverrides: {},
	mode: { kind: 'layout' },
	savedBaseline: baseline()
});
const file = (): LayoutFile => ({
	monitors: { b: emptyMonitorLayout() },
	fileLib: undefined,
	fileTheme: 'external',
	recoverCorrupt: false
});

describe('layout persistence planning', () => {
	it('preserves its inputs and leaves unchanged globals out of the transaction', () => {
		const current = view();
		const saved = file();
		const before = structuredClone({ current, saved });
		const plan = planLayoutSave(saved, current, []);
		expect(plan.touchedMonitors).toEqual(['a']);
		expect(plan.touchedGlobals).toEqual([]);
		expect(plan.document.monitors.b).toEqual(saved.monitors.b);
		expect(plan.document.theme).toBe('external');
		expect({ current, saved }).toEqual(before);
	});
	it('folds definition edits without replacing the real monitor or mutating the library', () => {
		const library: Library = {
			version: 1,
			defs: [
				{ id: 'd', name: 'D', size: { w: 10, h: 10 }, child: container('original', 'col', []) }
			]
		};
		const real = emptyMonitorLayout();
		const current = {
			...view(),
			library,
			savedBaseline: { ...baseline(), library },
			mode: { kind: 'definition' as const, defId: 'd', desktop: real, baseline: real },
			monitor: { root: container('edited', 'row', []), floating: [] }
		};
		const plan = planLayoutSave(file(), current, []);
		expect(plan.document.library?.defs[0].child.id).toBe('edited');
		expect(plan.document.monitors.a).toEqual(real);
		expect(library.defs[0].child.id).toBe('original');
		expect(plan.touchedGlobals).toEqual(['library']);
		const reverted = planLayoutRevert(file(), current.savedBaseline, 'a', current);
		expect(reverted.touchedGlobals).toEqual(['library']);
		expect(reverted.document.library?.defs[0].child.id).toBe('original');
	});
	it('restores omission-sensitive globals when reverting and preserves unrelated monitors', () => {
		const current = {
			...view(),
			selectedTheme: 'draft',
			tokenOverrides: { '--accent': 'red' },
			library: { version: 1 as const, defs: [] }
		};
		const plan = planLayoutRevert(file(), baseline(), 'a', current);
		expect(plan.touchedGlobals).toEqual(['library', 'theme', 'tokens']);
		expect(plan.document).not.toHaveProperty('library');
		expect(plan.document).not.toHaveProperty('theme');
		expect(plan.document).not.toHaveProperty('tokens');
		expect(Object.keys(plan.document.monitors)).toEqual(['b', 'a']);
	});
});
