// The plugin-PACKAGE orchestration (install/list/remove/manifest apply, toggle + consent gating,
// remote install/update/remove). The pure parse/validate lives in core/pluginPackage.ts and is
// tested there; this suite drives the ADAPTER half: discovery → rows, the enabled allowlist, the
// CSS/network consent gates, the template-group + sensor-catalog + theme-style side effects, and
// the {ok,error?} result branches of the remote ops. The two IO modules (the Tauri command adapter
// and the QuickJS poll-loop starter) are mocked so every branch runs without a backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- IO mocks ------------------------------------------------------------------------------------
// packages-commands is the only Tauri seam; we drive its read commands from in-memory fixtures and
// can make the remote (throwing) commands resolve or reject per test.
type PkgFile = { id: string; manifest: string; install: string | null };
let listFiles: PkgFile[] = [];
const assets = new Map<string, string>(); // keyed by `${id}/${name}`
let installImpl: (source: string) => Promise<{ id: string; version: string }>;
let checkImpl: (id: string) => Promise<{ current: string; latest: string; source: string }>;
let removeImpl: (id: string) => Promise<void>;
const installCalls: string[] = [];
const removeCalls: string[] = [];

vi.mock('./packages-commands', () => ({
	listPluginPackages: () => Promise.resolve(listFiles),
	readPluginPackageAsset: (id: string, name: string) =>
		Promise.resolve(assets.get(`${id}/${name}`) ?? null),
	installPluginPackage: (source: string) => {
		installCalls.push(source);
		return installImpl(source);
	},
	checkPluginPackageUpdate: (id: string) => checkImpl(id),
	removePluginPackage: (id: string) => {
		removeCalls.push(id);
		return removeImpl(id);
	}
}));

// packages-source is the poll-loop starter; we record starts + hand back a recording stop fn so we
// can assert the consent-gated lifecycle (started only on enable + matching net consent, stopped on
// disable/remove) without the real QuickJS sandbox.
const sourceStarts: string[] = [];
const sourceStops: string[] = [];
vi.mock('./packages-source', () => ({
	startPackageSource: (m: { id: string }) => {
		sourceStarts.push(m.id);
		return Promise.resolve(() => {
			sourceStops.push(m.id);
		});
	}
}));

import { createTelemetryHub } from '../../core/telemetry';
import { listTemplateGroups } from '../../core/templates';
import { listSources, sourceCatalogEntries } from '../../core/plugin';
import {
	checkPackageUpdate,
	enabledPackages,
	initPackages,
	installPackage,
	packagesStore,
	refreshPackages,
	removePackage,
	resetPackagesForTest,
	togglePackage,
	updatePackage,
	type PackageRow
} from './packages';

// ---- manifest fixtures ---------------------------------------------------------------------------

// A minimal structurally-valid layout node (a clock leaf) the template whitelist accepts.
const leafNode = (id = 'w1') => ({
	id,
	unit: { id, type: 'clock', rect: { x: 0, y: 0, w: 160, h: 40 }, config: { format: 'HH:mm' } }
});

const template = (id: string) => ({
	id,
	name: `Tpl ${id}`,
	size: { w: 100, h: 40 },
	tree: leafNode(id)
});

const manifestJson = (over: Record<string, unknown> = {}): string =>
	JSON.stringify({
		manifestVersion: 1,
		id: 'pack-a',
		name: 'Pack A',
		version: '1.0.0',
		templates: [template('t1')],
		...over
	});

const sidecarJson = (over: Record<string, unknown> = {}): string =>
	JSON.stringify({
		source: 'owner/repo',
		ref: 'main',
		version: '1.0.0',
		installedAt: 1000,
		...over
	});

// Register a single package on disk (and optionally its assets), then re-scan.
function setFiles(files: PkgFile[]): void {
	listFiles = files;
}

const rowFor = (id: string): PackageRow | undefined =>
	packagesStore.getSnapshot().find((r) => r.id === id);

const styleTagFor = (id: string): Element | null =>
	document.querySelector(`style[data-pkg-theme="${id}"]`);

const hub = createTelemetryHub();

beforeEach(() => {
	resetPackagesForTest();
	listFiles = [];
	assets.clear();
	installCalls.length = 0;
	removeCalls.length = 0;
	sourceStarts.length = 0;
	sourceStops.length = 0;
	installImpl = () => Promise.resolve({ id: 'pack-a', version: '1.0.0' });
	checkImpl = () => Promise.resolve({ current: '1.0.0', latest: '1.0.0', source: 'owner/repo' });
	removeImpl = () => Promise.resolve();
	// A clean head: strip any package theme tags a prior test left.
	document.querySelectorAll('style[data-pkg-theme]').forEach((el) => el.remove());
});

afterEach(() => {
	resetPackagesForTest();
});

// ---- discovery → rows ----------------------------------------------------------------------------

describe('refreshPackages → packagesStore rows', () => {
	it('publishes a row per discovered manifest with parsed metadata', async () => {
		setFiles([
			{
				id: 'pack-a',
				manifest: manifestJson({ description: 'desc', version: '2.3.4' }),
				install: null
			}
		]);
		await refreshPackages();

		const row = rowFor('pack-a')!;
		expect(row.name).toBe('Pack A');
		expect(row.version).toBe('2.3.4');
		expect(row.description).toBe('desc');
		expect(row.error).toBeNull();
		expect(row.warnings).toEqual([]);
		expect(row.templates).toBe(1);
		expect(row.themeName).toBeNull();
		expect(row.sensors).toBe(0);
		expect(row.hosts).toEqual([]);
		expect(row.installedFrom).toBeNull();
		expect(row.installedVersion).toBeUndefined();
	});

	it('rows an unparsed manifest as an error (folder id as name, no toggle metadata)', async () => {
		setFiles([{ id: 'pack-a', manifest: '{not json', install: null }]);
		await refreshPackages();

		const row = rowFor('pack-a')!;
		expect(row.error).toContain('not valid JSON');
		expect(row.name).toBe('pack-a'); // falls back to the bare folder id
		expect(row.version).toBe('');
		expect(row.templates).toBe(0);
	});

	it('carries dropped-template warnings onto the row but still loads the package', async () => {
		setFiles([
			{
				id: 'pack-a',
				manifest: manifestJson({
					templates: [
						{ id: 'bad', name: 'Bad', size: { w: 1, h: 1 }, tree: { not: 'a node' } },
						template('good')
					]
				}),
				install: null
			}
		]);
		await refreshPackages();

		const row = rowFor('pack-a')!;
		expect(row.error).toBeNull();
		expect(row.templates).toBe(1); // only the good one
		expect(row.warnings.join(' ')).toContain('"bad" dropped');
	});

	it('surfaces theme/source/host metadata from the manifest', async () => {
		setFiles([
			{
				id: 'pack-a',
				manifest: manifestJson({
					theme: { name: 'Midnight', file: 'theme.css' },
					source: { file: 'src.js', pollSeconds: 30, hosts: ['api.example.com'] },
					sensors: [{ id: 'temp', label: 'Temp' }]
				}),
				install: null
			}
		]);
		await refreshPackages();

		const row = rowFor('pack-a')!;
		expect(row.themeName).toBe('Midnight');
		expect(row.sensors).toBe(1);
		expect(row.hosts).toEqual(['api.example.com']);
	});

	it('reads provenance from a valid install sidecar', async () => {
		setFiles([
			{
				id: 'pack-a',
				manifest: manifestJson(),
				install: sidecarJson({ source: 'gh/owner', version: '0.9.0' })
			}
		]);
		await refreshPackages();

		const row = rowFor('pack-a')!;
		expect(row.installedFrom).toBe('gh/owner');
		expect(row.installedVersion).toBe('0.9.0');
	});

	it('treats a malformed sidecar as a hand-dropped (local) package', async () => {
		setFiles([{ id: 'pack-a', manifest: manifestJson(), install: '{bad sidecar' }]);
		await refreshPackages();

		const row = rowFor('pack-a')!;
		expect(row.installedFrom).toBeNull();
		expect(row.installedVersion).toBeUndefined();
	});

	it('drops rows for packages that vanished from disk on the next scan', async () => {
		setFiles([{ id: 'pack-a', manifest: manifestJson(), install: null }]);
		await refreshPackages();
		expect(rowFor('pack-a')).toBeDefined();

		setFiles([]);
		await refreshPackages();
		expect(packagesStore.getSnapshot()).toEqual([]);
	});
});

// ---- initPackages (one-shot) ---------------------------------------------------------------------

describe('initPackages', () => {
	it('discovers on first call and is idempotent on subsequent calls', async () => {
		setFiles([{ id: 'pack-a', manifest: manifestJson(), install: null }]);
		await initPackages(hub);
		expect(rowFor('pack-a')).toBeDefined();

		// A second init must NOT re-scan: change disk, re-init, rows stay as-was.
		setFiles([{ id: 'pack-b', manifest: manifestJson({ id: 'pack-b' }), install: null }]);
		await initPackages(hub);
		expect(rowFor('pack-b')).toBeUndefined();
		expect(rowFor('pack-a')).toBeDefined();
	});
});

// ---- togglePackage: enable side effects ----------------------------------------------------------

describe('togglePackage — enabling a plain package', () => {
	beforeEach(async () => {
		setFiles([{ id: 'pack-a', manifest: manifestJson(), install: null }]);
		await initPackages(hub);
	});

	it('registers the template group and records the id in the enabled allowlist', async () => {
		await togglePackage('pack-a', true);

		expect(enabledPackages.getSnapshot()).toContain('pack-a');
		const group = listTemplateGroups().find((g) => g.group === 'Pack A');
		expect(group?.templates).toHaveLength(1);
	});

	it('unregisters the group and drops the id when disabled', async () => {
		await togglePackage('pack-a', true);
		await togglePackage('pack-a', false);

		expect(enabledPackages.getSnapshot()).not.toContain('pack-a');
		expect(listTemplateGroups().find((g) => g.group === 'Pack A')).toBeUndefined();
	});

	it('does nothing for an unknown or unparsed package id', async () => {
		await togglePackage('nope', true);
		expect(enabledPackages.getSnapshot()).toEqual([]);
	});
});

// ---- togglePackage: CSS consent gate -------------------------------------------------------------

describe('togglePackage — theme CSS consent', () => {
	const REMOTE_CSS = 'body { background: url(https://evil.example.com/pixel.png); }';

	beforeEach(async () => {
		setFiles([
			{
				id: 'pack-a',
				manifest: manifestJson({ theme: { name: 'T', file: 'theme.css' } }),
				install: null
			}
		]);
		assets.set('pack-a/theme.css', REMOTE_CSS);
		await initPackages(hub);
	});

	it('injects a benign theme style without prompting', async () => {
		assets.set('pack-a/theme.css', 'body { color: red; }');
		const confirm = vi.fn(() => true);
		await togglePackage('pack-a', true, confirm);

		expect(confirm).not.toHaveBeenCalled();
		expect(styleTagFor('pack-a')?.textContent).toBe('body { color: red; }');
	});

	it('prompts once for a threat-flagged theme and injects after accept', async () => {
		const confirm = vi.fn<(message: string) => boolean>(() => true);
		await togglePackage('pack-a', true, confirm);

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0]![0]).toContain('remote resource');
		expect(styleTagFor('pack-a')).not.toBeNull();
		expect(enabledPackages.getSnapshot()).toContain('pack-a');
	});

	it('aborts the enable (no allowlist, no style) when the prompt is declined', async () => {
		const confirm = vi.fn(() => false);
		await togglePackage('pack-a', true, confirm);

		expect(enabledPackages.getSnapshot()).not.toContain('pack-a');
		expect(styleTagFor('pack-a')).toBeNull();
	});

	it('remembers CSS consent — re-enabling the same package does not re-prompt', async () => {
		await togglePackage('pack-a', true, () => true);
		await togglePackage('pack-a', false);

		const confirm = vi.fn(() => true);
		await togglePackage('pack-a', true, confirm);
		expect(confirm).not.toHaveBeenCalled(); // consent already stored
		expect(styleTagFor('pack-a')).not.toBeNull();
	});

	it('removes the theme style tag on disable', async () => {
		await togglePackage('pack-a', true, () => true);
		expect(styleTagFor('pack-a')).not.toBeNull();
		await togglePackage('pack-a', false);
		expect(styleTagFor('pack-a')).toBeNull();
	});

	it('enables without a prompt (and injects nothing) when the theme asset is missing on disk', async () => {
		// The manifest declares theme.css but the file was deleted: the pre-enable scan reads null
		// (→ no threats → no prompt) and the injection's own null-check skips the style tag.
		assets.clear();
		const confirm = vi.fn(() => true);
		await togglePackage('pack-a', true, confirm);

		expect(confirm).not.toHaveBeenCalled();
		expect(enabledPackages.getSnapshot()).toContain('pack-a');
		expect(styleTagFor('pack-a')).toBeNull();
	});

	it('never injects a threat-flagged theme applied WITHOUT stored consent (boot-time fail-closed)', async () => {
		// The allowlist says enabled but no CSS consent was ever stored (e.g. the list was seeded on
		// another machine, or the theme turned threat-flagged after trust was cleared). The refresh
		// path applies the package directly — injectPackageTheme must fail closed.
		enabledPackages.set(['pack-a']);
		await refreshPackages();

		expect(enabledPackages.getSnapshot()).toContain('pack-a'); // still enabled…
		expect(styleTagFor('pack-a')).toBeNull(); // …but the flagged CSS never lands
	});

	it('clears the stored CSS trust when a consented package is removed', async () => {
		await togglePackage('pack-a', true, () => true); // stores CSS consent for the threat theme
		expect(styleTagFor('pack-a')).not.toBeNull();

		removeImpl = () => {
			setFiles([]);
			return Promise.resolve();
		};
		const r = await removePackage('pack-a');
		expect(r).toEqual({ ok: true });
		expect(styleTagFor('pack-a')).toBeNull();

		// Re-discovering the same package must RE-PROMPT — trust was cleared with the remove.
		setFiles([
			{
				id: 'pack-a',
				manifest: manifestJson({ theme: { name: 'T', file: 'theme.css' } }),
				install: null
			}
		]);
		assets.set('pack-a/theme.css', REMOTE_CSS);
		await refreshPackages();
		const confirm = vi.fn(() => true);
		await togglePackage('pack-a', true, confirm);
		expect(confirm).toHaveBeenCalledTimes(1);
	});
});

// ---- togglePackage: network source consent + lifecycle -------------------------------------------

describe('togglePackage — network source consent', () => {
	beforeEach(async () => {
		setFiles([
			{
				id: 'pack-a',
				manifest: manifestJson({
					source: { file: 'src.js', pollSeconds: 30, hosts: ['api.example.com'] },
					sensors: [{ id: 'temp', label: 'Temp' }]
				}),
				install: null
			}
		]);
		await initPackages(hub);
	});

	it('registers catalog entries and starts the poll loop after net consent', async () => {
		const confirm = vi.fn<(message: string) => boolean>(() => true);
		await togglePackage('pack-a', true, confirm);

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0]![0]).toContain('polls the network');
		// The declared sensor + the implicit status sensor are now in the live catalog.
		const ids = sourceCatalogEntries().map((e) => e.id);
		expect(ids).toContain('pkg.pack-a.temp');
		expect(ids).toContain('pkg.pack-a.status');
		expect(sourceStarts).toContain('pack-a');
	});

	it('does not start the loop when the net prompt is declined', async () => {
		await togglePackage('pack-a', true, () => false);
		expect(enabledPackages.getSnapshot()).not.toContain('pack-a');
		expect(sourceStarts).toEqual([]);
	});

	it('stops the loop and unregisters the source on disable', async () => {
		await togglePackage('pack-a', true, () => true);
		expect(sourceStarts).toEqual(['pack-a']);
		await togglePackage('pack-a', false);
		expect(sourceStops).toContain('pack-a');
		expect(sourceCatalogEntries().map((e) => e.id)).not.toContain('pkg.pack-a.temp');
	});

	it('re-applies an enabled source on refresh without stacking two loops', async () => {
		await togglePackage('pack-a', true, () => true);
		sourceStarts.length = 0;
		sourceStops.length = 0;
		await refreshPackages();
		// applyPackage stops any prior loop, then starts the fresh one exactly once.
		expect(sourceStarts).toEqual(['pack-a']);
		expect(sourceStops).toEqual(['pack-a']);
	});

	it('auto-approves via the default confirm when no callback is passed', async () => {
		// Omitting confirmEnable uses the default `() => true`, so the consent gate auto-approves.
		await togglePackage('pack-a', true);
		expect(enabledPackages.getSnapshot()).toContain('pack-a');
		expect(sourceStarts).toContain('pack-a');
	});

	it('registers an inert no-op start for the pkg source (lifecycle is owned here, not startAllSources)', async () => {
		await togglePackage('pack-a', true, () => true);
		const src = listSources().find((s) => s.id === 'pkg:pack-a')!;
		expect(src).toBeDefined();
		// The registered start is deliberately a no-op: invoking it just yields a no-op stop fn.
		const stop = await src.start(hub);
		expect(typeof stop).toBe('function');
		expect(stop()).toBeUndefined();
	});

	it('catalogs a label-less sensor bare and carries a declared unit through', async () => {
		setFiles([
			{
				id: 'pack-a',
				manifest: manifestJson({
					// No templates key at all — a source-only package registers no palette group.
					templates: undefined,
					source: { file: 'src.js', pollSeconds: 30, hosts: ['api.example.com'] },
					sensors: [{ id: 'raw' }, { id: 'load', label: 'Load', unit: '%' }]
				}),
				install: null
			}
		]);
		await refreshPackages();
		await togglePackage('pack-a', true, () => true);

		const entries = sourceCatalogEntries().filter((e) => e.id.startsWith('pkg.pack-a.'));
		const raw = entries.find((e) => e.id === 'pkg.pack-a.raw')!;
		expect(raw.label).toBeUndefined(); // no label declared → none invented
		expect(raw.unit).toBeUndefined();
		const load = entries.find((e) => e.id === 'pkg.pack-a.load')!;
		expect(load.label).toBe('Load');
		expect(load.unit).toBe('%');
		// And with no templates, no palette group was registered under the package name.
		expect(listTemplateGroups().find((g) => g.group === 'Pack A')).toBeUndefined();
	});

	it('stops an orphaned running loop on reset even after its manifest broke on disk', async () => {
		await togglePackage('pack-a', true, () => true);
		expect(sourceStarts).toEqual(['pack-a']);

		// The manifest breaks on disk; the re-scan rows it as an error. The vanish-loop doesn't fire
		// (the id is still live) and the enable-loop skips the unparsed entry — so the old poll loop
		// keeps running, tracked only in runningSources.
		setFiles([{ id: 'pack-a', manifest: '{broken', install: null }]);
		sourceStops.length = 0;
		await refreshPackages();
		expect(sourceStops).toEqual([]); // nothing stopped it yet

		// The reset sweep must catch it via runningSources, not via the (unparsed) discovered entry.
		resetPackagesForTest();
		expect(sourceStops).toEqual(['pack-a']);
	});
});

// ---- installPackage ------------------------------------------------------------------------------

describe('installPackage', () => {
	it('installs then re-scans, returning ok (fresh install lands disabled)', async () => {
		installImpl = (source) => {
			expect(source).toBe('owner/repo');
			setFiles([{ id: 'pack-a', manifest: manifestJson(), install: sidecarJson() }]);
			return Promise.resolve({ id: 'pack-a', version: '1.0.0' });
		};
		const r = await installPackage('owner/repo');

		expect(r).toEqual({ ok: true });
		expect(rowFor('pack-a')).toBeDefined();
		expect(enabledPackages.getSnapshot()).toEqual([]); // opt-in: untouched
	});

	it('returns the backend error string on failure', async () => {
		installImpl = () => Promise.reject(new Error('network down'));
		const r = await installPackage('owner/repo');

		expect(r.ok).toBe(false);
		expect(r.error).toContain('network down');
	});
});

// ---- checkPackageUpdate --------------------------------------------------------------------------

describe('checkPackageUpdate', () => {
	it('reports updateAvailable=false when versions match', async () => {
		checkImpl = () => Promise.resolve({ current: '1.0.0', latest: '1.0.0', source: 'owner/repo' });
		const r = await checkPackageUpdate('pack-a');

		expect(r).toEqual({
			ok: true,
			current: '1.0.0',
			latest: '1.0.0',
			updateAvailable: false
		});
	});

	it('reports updateAvailable=true when the version strings differ', async () => {
		checkImpl = () => Promise.resolve({ current: '1.0.0', latest: '1.1.0', source: 'owner/repo' });
		const r = await checkPackageUpdate('pack-a');

		expect(r.ok).toBe(true);
		if (r.ok) expect(r.updateAvailable).toBe(true);
	});

	it('returns an error result when the check throws', async () => {
		checkImpl = () => Promise.reject(new Error('no sidecar'));
		const r = await checkPackageUpdate('pack-a');

		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('no sidecar');
	});
});

// ---- updatePackage -------------------------------------------------------------------------------

describe('updatePackage', () => {
	it('refuses a hand-dropped (no-sidecar) package', async () => {
		setFiles([{ id: 'pack-a', manifest: manifestJson(), install: null }]);
		await initPackages(hub);

		const r = await updatePackage('pack-a');
		expect(r.ok).toBe(false);
		expect(r.error).toContain('not installed from a URL');
		expect(installCalls).toEqual([]);
	});

	it('re-installs from the recorded source and re-scans on success', async () => {
		setFiles([{ id: 'pack-a', manifest: manifestJson(), install: sidecarJson() }]);
		await initPackages(hub);

		const r = await updatePackage('pack-a');
		expect(r).toEqual({ ok: true });
		// ref 'main' round-trips as the bare source string.
		expect(installCalls).toEqual(['owner/repo']);
	});

	it('feeds reinstallSource a pinned-ref URL', async () => {
		setFiles([{ id: 'pack-a', manifest: manifestJson(), install: sidecarJson({ ref: 'v2' }) }]);
		await initPackages(hub);

		await updatePackage('pack-a');
		expect(installCalls).toEqual(['https://github.com/owner/repo/tree/v2']);
	});

	it('restores the old registration and returns an error when the re-install fails', async () => {
		setFiles([{ id: 'pack-a', manifest: manifestJson(), install: sidecarJson() }]);
		await initPackages(hub);
		await togglePackage('pack-a', true);
		expect(listTemplateGroups().find((g) => g.group === 'Pack A')).toBeDefined();

		installImpl = () => Promise.reject(new Error('boom'));
		const r = await updatePackage('pack-a');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('boom');
		// The closing refresh restored the still-enabled old version's group.
		expect(listTemplateGroups().find((g) => g.group === 'Pack A')).toBeDefined();
	});

	it('drops stale network consent when the update changes the hosts list', async () => {
		setFiles([
			{
				id: 'pack-a',
				manifest: manifestJson({
					source: { file: 'src.js', pollSeconds: 30, hosts: ['api.example.com'] },
					sensors: [{ id: 'temp' }]
				}),
				install: sidecarJson()
			}
		]);
		await initPackages(hub);
		await togglePackage('pack-a', true, () => true); // consent for api.example.com
		expect(sourceStarts).toContain('pack-a');

		// The update ships a manifest with a DIFFERENT host — the install writes it to disk.
		installImpl = () => {
			setFiles([
				{
					id: 'pack-a',
					manifest: manifestJson({
						source: { file: 'src.js', pollSeconds: 30, hosts: ['other.example.com'] },
						sensors: [{ id: 'temp' }]
					}),
					install: sidecarJson({ version: '2.0.0' })
				}
			]);
			return Promise.resolve({ id: 'pack-a', version: '2.0.0' });
		};
		sourceStarts.length = 0;
		await updatePackage('pack-a');

		// Stale consent dropped → the new host's loop stays OFF until re-confirmed.
		expect(sourceStarts).toEqual([]);
		// Re-enabling now re-prompts (consent was cleared).
		const confirm = vi.fn(() => true);
		await togglePackage('pack-a', false);
		await togglePackage('pack-a', true, confirm);
		expect(confirm).toHaveBeenCalledTimes(1);
	});
});

// ---- removePackage -------------------------------------------------------------------------------

describe('removePackage', () => {
	it('clears the enable + consent allowlists, deletes, and re-scans on success', async () => {
		setFiles([
			{
				id: 'pack-a',
				manifest: manifestJson({ theme: { name: 'T', file: 'theme.css' } }),
				install: null
			}
		]);
		assets.set('pack-a/theme.css', 'body { color: red; }');
		await initPackages(hub);
		await togglePackage('pack-a', true);
		expect(enabledPackages.getSnapshot()).toContain('pack-a');

		removeImpl = (id) => {
			expect(id).toBe('pack-a');
			setFiles([]); // the folder is gone after delete
			return Promise.resolve();
		};
		const r = await removePackage('pack-a');

		expect(r).toEqual({ ok: true });
		expect(removeCalls).toEqual(['pack-a']);
		expect(enabledPackages.getSnapshot()).not.toContain('pack-a');
		expect(rowFor('pack-a')).toBeUndefined();
		expect(styleTagFor('pack-a')).toBeNull();
	});

	it('clears stored network consent on remove', async () => {
		setFiles([
			{
				id: 'pack-a',
				manifest: manifestJson({
					source: { file: 'src.js', pollSeconds: 30, hosts: ['api.example.com'] },
					sensors: [{ id: 'temp' }]
				}),
				install: null
			}
		]);
		await initPackages(hub);
		await togglePackage('pack-a', true, () => true); // stores net consent + starts the loop

		removeImpl = () => {
			setFiles([]);
			return Promise.resolve();
		};
		const r = await removePackage('pack-a');
		expect(r).toEqual({ ok: true });
		expect(sourceStops).toContain('pack-a'); // loop stopped on remove

		// Re-discovering the same package and re-enabling must re-prompt — consent was cleared.
		setFiles([
			{
				id: 'pack-a',
				manifest: manifestJson({
					source: { file: 'src.js', pollSeconds: 30, hosts: ['api.example.com'] },
					sensors: [{ id: 'temp' }]
				}),
				install: null
			}
		]);
		await refreshPackages();
		const confirm = vi.fn(() => true);
		await togglePackage('pack-a', true, confirm);
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it('returns an error and re-scans (restoring the row) when the delete fails', async () => {
		setFiles([{ id: 'pack-a', manifest: manifestJson(), install: null }]);
		await initPackages(hub);

		removeImpl = () => Promise.reject(new Error('locked'));
		const r = await removePackage('pack-a');

		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('locked');
		// The closing refresh re-discovered the still-present folder.
		expect(rowFor('pack-a')).toBeDefined();
	});

	it('deletes a folder that was never discovered (nothing to unregister first)', async () => {
		// The Plugins panel can race a manual folder delete: the id is gone from `discovered` but the
		// dir still exists. removePackage must skip the un-apply and still delete + re-scan.
		await initPackages(hub); // empty disk — nothing discovered
		const r = await removePackage('ghost');

		expect(r).toEqual({ ok: true });
		expect(removeCalls).toEqual(['ghost']);
	});
});

// ---- resetPackagesForTest ------------------------------------------------------------------------

describe('resetPackagesForTest', () => {
	it('clears rows, the enabled allowlist, and any registered groups/styles', async () => {
		setFiles([
			{
				id: 'pack-a',
				manifest: manifestJson({ theme: { name: 'T', file: 'theme.css' } }),
				install: null
			}
		]);
		assets.set('pack-a/theme.css', 'body { color: red; }');
		await initPackages(hub);
		await togglePackage('pack-a', true);

		resetPackagesForTest();

		expect(packagesStore.getSnapshot()).toEqual([]);
		expect(enabledPackages.getSnapshot()).toEqual([]);
		expect(listTemplateGroups().find((g) => g.group === 'Pack A')).toBeUndefined();
		expect(styleTagFor('pack-a')).toBeNull();
	});
});

// ---- netConsent store parse (parseConsentMap) ----------------------------------------------------
// The network-consent map is parsed once at module load from localStorage. Seed a populated map
// (with a non-string entry to prove the typeof filter) and re-import the module so the parse runs
// its object-iteration path; the loaded consent must then let an enable skip the net prompt.

describe('netConsent persisted map parsing', () => {
	it('loads a stored consent map (string values only) so a matching enable does not re-prompt', async () => {
		// fingerprint of ['api.example.com'] is the sorted-join → the host itself. The `dropped: 123`
		// entry proves parseConsentMap's `typeof v === 'string'` filter skips non-string values.
		localStorage.setItem(
			'widgetsack.packages.netConsent',
			JSON.stringify({ 'pack-a': 'api.example.com', dropped: 123 })
		);
		// Fresh module instance: its module-level createPersistedStore(..., parseConsentMap) parses
		// the seeded map (the object-iteration path). DON'T resetPackagesForTest — that clears it.
		vi.resetModules();
		const m = await import('./packages');
		setFiles([
			{
				id: 'pack-a',
				manifest: manifestJson({
					source: { file: 'src.js', pollSeconds: 30, hosts: ['api.example.com'] },
					sensors: [{ id: 'temp', label: 'Temp' }]
				}),
				install: null
			}
		]);
		await m.initPackages(createTelemetryHub());
		const confirm = vi.fn(() => true);
		await m.togglePackage('pack-a', true, confirm);
		// Consent for these exact hosts was already loaded from storage → no prompt.
		expect(confirm).not.toHaveBeenCalled();
		expect(sourceStarts).toContain('pack-a');
		m.resetPackagesForTest();
		localStorage.removeItem('widgetsack.packages.netConsent');
		vi.resetModules();
	});
});
