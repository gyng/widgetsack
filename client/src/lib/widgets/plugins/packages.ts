// Third-party plugin packages — the orchestration half (the pure parse/validate lives in
// core/pluginPackage.ts; the raw file I/O in packages-commands.ts). Canvas calls `initPackages()`
// once per window (both roles): discover `plugins/<id>/plugin.json`, parse every manifest
// (failures become warn rows in the Plugins panel, like pluginLoadErrors), and apply the ENABLED
// ones — register their templates as a named group in the Add palette / widget designer, inject
// their theme CSS (scanned by core/cssThreats; injected only with the user's stored consent), and
// run their sandboxed sensor source (Phase 2 — QuickJS poll loop in packages-source.ts, started
// only with stored network consent for the manifest's exact hosts list). Packages are OPT-IN: the
// enabled list is an explicit localStorage allowlist that starts empty, so a freshly dropped
// folder registers nothing until the user flips its toggle.

import { createStore } from '../../../stores/createStore';
import { createPersistedStore } from '../../../stores/persist';
import { scanCssThreats, threatSummary } from '../../core/cssThreats';
import { registerSource, unregisterSource, type SensorCatalogEntry } from '../../core/plugin';
import {
	consentFingerprint,
	enableConsentMessage,
	packageSensorId,
	packageTemplates,
	parseInstallSidecar,
	parsePluginPackage,
	reinstallSource,
	versionsDiffer,
	type InstallSidecar,
	type PluginPackageManifest
} from '../../core/pluginPackage';
import { registerTemplates, unregisterTemplates } from '../../core/templates';
import type { TelemetryHub } from '../../core/telemetry';
import {
	checkPluginPackageUpdate,
	installPluginPackage,
	listPluginPackages,
	readPluginPackageAsset,
	removePluginPackage
} from './packages-commands';
import { startPackageSource } from './packages-source';

// One discovered package directory: either a parsed manifest (+ drop warnings) or a parse error.
type Discovered = {
	id: string;
	manifest: PluginPackageManifest | null;
	error: string | null;
	warnings: string[];
	/** Provenance when installed from a URL (the `.install.json` sidecar); null = hand-dropped. */
	install: InstallSidecar | null;
};

/** What the Plugins panel renders per package row. */
export type PackageRow = {
	id: string;
	name: string; // manifest name, or the bare folder id when the manifest failed to parse
	version: string;
	description?: string;
	/** Manifest parse failure (→ warn dot + reason, no toggle). Null when parsed. */
	error: string | null;
	/** Dropped-template / dropped-theme reasons (→ warn dot, still toggleable). */
	warnings: string[];
	templates: number;
	themeName: string | null;
	/** Declared source sensors (0 when the package has no source). */
	sensors: number;
	/** The source's network allowlist ([] when no source) — shown as a dim "network:" line. */
	hosts: string[];
	/** The install source (`owner/repo` or a URL) when installed via `installPackage`; null for a
	 * hand-dropped folder (no update-check affordance — there's nowhere to check against). */
	installedFrom: string | null;
	/** The version recorded at install time (usually equals `version` from the manifest). */
	installedVersion?: string;
};

const parseIds = (raw: unknown): string[] =>
	Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];

/** The opt-in allowlist of enabled package ids (default: nothing enabled). */
export const enabledPackages = createPersistedStore<string[]>(
	'widgetsack.packages.enabled',
	parseIds
);

const parseConsentMap = (raw: unknown): Record<string, string> => {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
	return out;
};

// Exact threat-flagged stylesheet text accepted per package. Keying consent by the reviewed content
// (not just id) means an update cannot inherit permission for newly-added remote URLs / overlays.
// Legacy string[] consent is deliberately discarded by parseConsentMap and must be earned again.
const trustedCssPackages = createPersistedStore<Record<string, string>>(
	'widgetsack.packages.cssTrusted',
	parseConsentMap
);

// Network consent per package id, keyed by the hosts FINGERPRINT (sorted hosts string) the user
// saw in the first-enable confirm. A manifest update that changes the hosts list mismatches the
// stored fingerprint, so the source stays stopped until the new hosts are re-confirmed.
const netConsentPackages = createPersistedStore<Record<string, string>>(
	'widgetsack.packages.netConsent',
	parseConsentMap
);

/** The discovered package rows, for the Plugins panel (subscribe via useStore). */
export const packagesStore = createStore<PackageRow[]>([]);

const discovered = new Map<string, Discovered>();

function rowOf(d: Discovered): PackageRow {
	return {
		id: d.id,
		name: d.manifest?.name ?? d.id,
		version: d.manifest?.version ?? '',
		...(d.manifest?.description !== undefined ? { description: d.manifest.description } : {}),
		error: d.error,
		warnings: d.warnings.slice(),
		templates: d.manifest?.templates.length ?? 0,
		themeName: d.manifest?.theme?.name ?? null,
		sensors: d.manifest?.source ? d.manifest.sensors.length : 0,
		hosts: d.manifest?.source?.hosts.slice() ?? [],
		installedFrom: d.install?.source ?? null,
		...(d.install ? { installedVersion: d.install.version } : {})
	};
}

function publishRows(): void {
	packagesStore.set(Array.from(discovered.values(), rowOf));
}

// ---- theme injection ---------------------------------------------------------------------------
// A package theme is a plain <style> tag per package (data-pkg-theme="<id>") in THIS window's
// head — independent of the user's selected theme, removed on disable. Injected only when the
// scan is clean or the user stored consent at enable time.

function removePackageTheme(id: string): void {
	document.querySelector(`style[data-pkg-theme="${CSS.escape(id)}"]`)?.remove();
}

async function injectPackageTheme(d: Discovered): Promise<void> {
	const theme = d.manifest?.theme;
	if (!theme) return;
	const css = await readPluginPackageAsset(d.id, theme.file);
	if (css == null) return;
	if (scanCssThreats(css).length && trustedCssPackages.getSnapshot()[d.id] !== css) return;
	removePackageTheme(d.id);
	const el = document.createElement('style');
	el.setAttribute('data-pkg-theme', d.id);
	el.textContent = css;
	document.head.appendChild(el);
}

// ---- sandboxed sensor sources (Phase 2) ----------------------------------------------------------
// The poll loop itself lives in packages-source.ts; this module owns WHEN it runs: started by
// applyPackage when a package is enabled AND its hosts fingerprint matches the stored network
// consent, stopped on disable/remove/refresh. The hub arrives from Canvas via initPackages — the
// loop ingests into THIS window's hub, exactly like the first-party sources.

let hubRef: TelemetryHub | null = null;

// One running poll loop's stop function per package id.
const runningSources = new Map<string, () => void>();

function stopPackageSource(id: string): void {
	runningSources.get(id)?.();
	runningSources.delete(id);
}

function netConsented(d: Discovered): boolean {
	const hosts = d.manifest?.source?.hosts;
	if (!hosts) return false;
	return netConsentPackages.getSnapshot()[d.id] === consentFingerprint(hosts);
}

// The sensor-catalog entries a package's source contributes: its declared sensors (namespaced,
// with the manifest's label/unit) plus the implicit status sensor. Registered as a no-op-start
// SensorSource purely so sourceCatalogEntries() — which reads the registry live — surfaces them
// in the Inspector dropdown / Sensors browser; the poll loop's lifecycle is owned HERE (start on
// enable+consent, stop on disable), not by the one-shot startAllSources at Canvas init.
function packageCatalog(m: PluginPackageManifest): SensorCatalogEntry[] {
	const entries: SensorCatalogEntry[] = m.sensors.map((s) => ({
		id: packageSensorId(m.id, s.id),
		...(s.label !== undefined ? { label: s.label } : {}),
		...(s.unit !== undefined ? { unit: s.unit } : {})
	}));
	entries.push({ id: packageSensorId(m.id, 'status'), label: `${m.name} status` });
	return entries;
}

// ---- registration ------------------------------------------------------------------------------

// Apply one package's enabled state: register/unregister its template group (keyed by stable
// package id, with the display name used only as the palette heading), add/remove its theme style,
// and start/stop its sandboxed source (+ catalog entries).
async function applyPackage(d: Discovered, enabled: boolean): Promise<void> {
	if (!d.manifest) return; // unparsed packages register nothing
	if (enabled) {
		if (d.manifest.templates.length) {
			registerTemplates(`pkg:${d.id}`, packageTemplates(d.manifest), d.manifest.name);
		}
		await injectPackageTheme(d);
		if (d.manifest.source) {
			const m = d.manifest;
			registerSource({
				id: `pkg:${d.id}`,
				start: async () => () => undefined, // lifecycle owned here, not by startAllSources
				catalogEntries: () => packageCatalog(m)
			});
			stopPackageSource(d.id); // refresh re-applies — never stack two loops
			// Consent-gated: a hosts list the user never confirmed (fresh enable race, manifest
			// edited on disk, update that changed hosts) keeps the loop OFF, fail-closed.
			if (hubRef && netConsented(d)) {
				runningSources.set(d.id, await startPackageSource(m, hubRef));
			}
		}
	} else {
		unregisterTemplates(`pkg:${d.id}`);
		removePackageTheme(d.id);
		unregisterSource(`pkg:${d.id}`);
		stopPackageSource(d.id);
	}
}

/**
 * (Re)discover the package directories and re-apply the enabled ones. Called at init and when
 * the Plugins panel opens (so a freshly dropped folder shows up without a restart). A package
 * that vanished from disk keeps nothing registered (its group is unregistered below).
 */
async function refreshPackagesNow(): Promise<void> {
	const files = await listPluginPackages();
	// Unregister groups for packages that disappeared since the last scan.
	const liveIds = new Set(files.map((f) => f.id));
	for (const [id, d] of discovered) {
		if (!liveIds.has(id)) void applyPackage(d, false);
	}
	discovered.clear();
	for (const f of files) {
		const result = parsePluginPackage(f.id, f.manifest);
		const install = parseInstallSidecar(f.install);
		discovered.set(
			f.id,
			result.ok
				? {
						id: f.id,
						manifest: result.pkg.manifest,
						error: null,
						warnings: result.pkg.warnings,
						install
					}
				: { id: f.id, manifest: null, error: result.reason, warnings: [], install }
		);
	}
	publishRows();
	const enabled = new Set(enabledPackages.getSnapshot());
	for (const d of discovered.values()) {
		if (enabled.has(d.id)) await applyPackage(d, true);
	}
}

// Every caller shares one queue. This prevents an older async scan from committing after a newer
// install/update/remove scan and keeps source stop/start transitions strictly ordered.
let refreshTail: Promise<void> = Promise.resolve();

export function refreshPackages(): Promise<void> {
	const pending = refreshTail.then(refreshPackagesNow, refreshPackagesNow);
	refreshTail = pending.catch(() => undefined);
	return pending;
}

let initialized = false;

/** One-shot init per window (Canvas mount, both roles — idempotent like registerBuiltinPlugins).
 * `hub` is this window's telemetry hub — package sources ingest into it (overlays poll too, so an
 * overlay-only widget bound to a package sensor works without the studio open). */
export async function initPackages(hub: TelemetryHub): Promise<void> {
	if (initialized) return;
	initialized = true;
	hubRef = hub;
	await refreshPackages();
}

/**
 * Flip one package's enabled state, LIVE (templates appear in / vanish from the palette without
 * a reload; the theme style tag follows; a source's poll loop starts/stops). On the FIRST enable
 * of a package whose theme CSS scans with threats AND/OR which declares a network source,
 * `confirmEnable` is asked with a combined message stating both facts (the Plugins panel passes
 * window.confirm); declining aborts the enable. Both consents are stored — CSS by exact stylesheet,
 * network by hosts FINGERPRINT — so changed content/hosts re-prompt while unchanged packages apply
 * on subsequent boots. Other windows pick the change up on their next reload; localStorage is shared.
 */
export async function togglePackage(
	id: string,
	enabled: boolean,
	confirmEnable: (message: string) => boolean = () => true
): Promise<void> {
	const d = discovered.get(id);
	if (!d?.manifest) return; // unknown / unparsed → not toggleable
	if (enabled) {
		let cssSummary: string | null = null;
		let cssConsent: string | null = null;
		if (d.manifest.theme) {
			const css = await readPluginPackageAsset(id, d.manifest.theme.file);
			const threats = css ? scanCssThreats(css) : [];
			if (css && threats.length && trustedCssPackages.getSnapshot()[id] !== css) {
				cssSummary = threatSummary(threats);
				cssConsent = css;
			}
		}
		const source = d.manifest.source;
		const fingerprint = source ? consentFingerprint(source.hosts) : null;
		const needsNet = fingerprint !== null && netConsentPackages.getSnapshot()[id] !== fingerprint;
		if (cssSummary !== null || needsNet) {
			const message = enableConsentMessage({
				...(cssSummary !== null ? { cssSummary } : {}),
				...(needsNet && source ? { hosts: source.hosts, pollSeconds: source.pollSeconds } : {})
			});
			if (!confirmEnable(message)) return;
			if (cssConsent !== null) trustedCssPackages.update((m) => ({ ...m, [id]: cssConsent }));
			if (needsNet && fingerprint !== null) {
				netConsentPackages.update((m) => ({ ...m, [id]: fingerprint }));
			}
		}
	}
	enabledPackages.update((ids) => {
		const without = ids.filter((x) => x !== id);
		return enabled ? [...without, id] : without;
	});
	await applyPackage(d, enabled);
}

// ---- remote install / update / remove (Phase 3) --------------------------------------------------
// All three return `{ ok, error? }` instead of throwing so the panel can window.alert the reason
// without try/catch noise. Every mutation ends in refreshPackages() — the single re-scan +
// re-apply path — so the rows, the palette groups, and the theme tags can never drift from disk.

export type PackageOpResult = { ok: boolean; error?: string };

/**
 * Install a package from `owner/repo`, a github.com repo URL, or an https plugin.json URL. The
 * backend fetches + writes the folder; the refresh re-discovers it. Fresh installs land DISABLED
 * (the opt-in allowlist is untouched) — same trust gate as a hand-dropped folder.
 */
export async function installPackage(source: string): Promise<PackageOpResult> {
	try {
		await installPluginPackage(source);
	} catch (err) {
		return { ok: false, error: String(err) };
	}
	await refreshPackages();
	return { ok: true };
}

/** What a manual update check tells the row. */
export type PackageUpdateStatus =
	| { ok: true; current: string; latest: string; updateAvailable: boolean }
	| { ok: false; error: string };

/** MANUAL update check: re-fetch just the manifest from the recorded install source and compare
 * version strings (any difference = update available; downgrades are deliberate re-installs). */
export async function checkPackageUpdate(id: string): Promise<PackageUpdateStatus> {
	try {
		const r = await checkPluginPackageUpdate(id);
		return {
			ok: true,
			current: r.current,
			latest: r.latest,
			updateAvailable: versionsDiffer(r.current, r.latest)
		};
	} catch (err) {
		return { ok: false, error: String(err) };
	}
}

/**
 * Re-install from the recorded source (a pinned ref round-trips via `reinstallSource`). The old
 * registration is dropped FIRST when the package is enabled — a renamed manifest would otherwise
 * strand its palette group under the stale name — and the closing refresh re-applies the new
 * version live.
 */
export async function updatePackage(id: string): Promise<PackageOpResult> {
	const d = discovered.get(id);
	if (!d?.install) return { ok: false, error: 'package was not installed from a URL' };
	if (enabledPackages.getSnapshot().includes(id)) await applyPackage(d, false);
	try {
		await installPluginPackage(reinstallSource(d.install), id);
	} catch (err) {
		await refreshPackages(); // restore the (still enabled) old version's registration
		return { ok: false, error: String(err) };
	}
	await refreshPackages();
	// If the update CHANGED the hosts list (or dropped the source), the stored network consent is
	// stale — drop it so the new hosts must be re-confirmed (toggle off/on). The fingerprint check
	// in applyPackage already kept the new source from starting during the refresh above.
	const next = discovered.get(id);
	const nextFp = next?.manifest?.source ? consentFingerprint(next.manifest.source.hosts) : null;
	netConsentPackages.update((m) => {
		if (m[id] === undefined || m[id] === nextFp) return m;
		const rest = { ...m };
		delete rest[id];
		return rest;
	});
	return { ok: true };
}

/**
 * Remove a package (works for installed AND hand-dropped folders — it's a dir delete): live-drop
 * its templates/theme, clear it from the enable allowlist AND the stored CSS consent (a future
 * re-install must re-earn trust), then delete and re-scan.
 */
export async function removePackage(id: string): Promise<PackageOpResult> {
	const d = discovered.get(id);
	if (d) await applyPackage(d, false);
	enabledPackages.update((ids) => ids.filter((x) => x !== id));
	trustedCssPackages.update((m) => {
		if (m[id] === undefined) return m;
		const rest = { ...m };
		delete rest[id];
		return rest;
	});
	netConsentPackages.update((m) => {
		if (m[id] === undefined) return m;
		const rest = { ...m };
		delete rest[id];
		return rest;
	});
	try {
		await removePluginPackage(id);
	} catch (err) {
		await refreshPackages();
		return { ok: false, error: String(err) };
	}
	await refreshPackages();
	return { ok: true };
}

/** TEST-ONLY: drop all module state so each test starts from a clean registry. */
export function resetPackagesForTest(): void {
	for (const d of discovered.values()) void applyPackage(d, false);
	for (const stop of runningSources.values()) stop();
	runningSources.clear();
	discovered.clear();
	publishRows();
	enabledPackages.set([]);
	trustedCssPackages.set({});
	netConsentPackages.set({});
	hubRef = null;
	initialized = false;
	refreshTail = Promise.resolve();
}
