// The module-load parse of the three persisted package stores (enabled allowlist / CSS trust /
// network consent). packages.test.ts covers a RE-imported module via vi.resetModules; this sibling
// seeds localStorage BEFORE the module's first import so the initial createPersistedStore parse runs
// against real stored values — including the non-string entries the parsers must drop.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./packages-commands', () => ({
	listPluginPackages: vi.fn(() => Promise.resolve([])),
	readPluginPackageAsset: vi.fn(() => Promise.resolve(null)),
	installPluginPackage: vi.fn(() => Promise.resolve({ id: 'x', version: '1' })),
	checkPluginPackageUpdate: vi.fn(() =>
		Promise.resolve({ current: '1', latest: '1', source: 'o/r' })
	),
	removePluginPackage: vi.fn(() => Promise.resolve())
}));
vi.mock('./packages-source', () => ({
	startPackageSource: vi.fn(() => Promise.resolve(() => undefined))
}));

const KEYS = [
	'widgetsack.packages.enabled',
	'widgetsack.packages.cssTrusted',
	'widgetsack.packages.netConsent'
];

afterEach(() => {
	for (const k of KEYS) localStorage.removeItem(k);
	vi.resetModules();
});

describe('persisted package stores — module-load parsing', () => {
	it('keeps only string ids from the stored enabled list and string values from the consent map', async () => {
		// Corrupt-ish storage: each list carries a non-string entry the parser must drop.
		localStorage.setItem('widgetsack.packages.enabled', JSON.stringify(['pack-a', 42, 'pack-b']));
		localStorage.setItem('widgetsack.packages.cssTrusted', JSON.stringify(['pack-a', false]));
		localStorage.setItem(
			'widgetsack.packages.netConsent',
			JSON.stringify({ 'pack-a': 'api.example.com', dropped: 123 })
		);

		const m = await import('./packages');
		expect(m.enabledPackages.getSnapshot()).toEqual(['pack-a', 'pack-b']);
		// The consent map round-trips through the persist-at-creation write: string values only.
		const consent = JSON.parse(localStorage.getItem('widgetsack.packages.netConsent')!);
		expect(consent).toEqual({ 'pack-a': 'api.example.com' });
		m.resetPackagesForTest();
	});

	it('falls back to empty stores when the stored shapes are wrong (array/object mismatch)', async () => {
		localStorage.setItem('widgetsack.packages.enabled', JSON.stringify({ not: 'an array' }));
		localStorage.setItem('widgetsack.packages.netConsent', JSON.stringify(['not', 'a', 'map']));

		const m = await import('./packages');
		expect(m.enabledPackages.getSnapshot()).toEqual([]);
		expect(JSON.parse(localStorage.getItem('widgetsack.packages.netConsent')!)).toEqual({});
		m.resetPackagesForTest();
	});

	it('drops a consent map whose values are all non-strings (empty map, no consent granted)', async () => {
		localStorage.setItem(
			'widgetsack.packages.netConsent',
			JSON.stringify({ 'pack-a': 123, 'pack-b': { nested: true } })
		);

		const m = await import('./packages');
		// Every entry was dropped → the persist-at-creation write stores a clean {}.
		expect(JSON.parse(localStorage.getItem('widgetsack.packages.netConsent')!)).toEqual({});
		m.resetPackagesForTest();
	});
});
