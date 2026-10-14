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
	packageTemplateThreats,
	packageTemplates,
	parseInstallSidecar,
	parsePluginPackage,
	reinstallSource,
	installSourceLabel,
	templateThreatFingerprint,
	versionsDiffer,
	type InstallSidecar,
	type PluginPackageManifest
} from '../../core/pluginPackage';
import { treeThreatSummary } from '../../core/treeThreats';
import { registerTemplates, unregisterTemplates } from '../../core/templates';
import type { TelemetryHub } from '../../core/telemetry';
import {
	checkPluginPackageUpdate,
	installPluginPackage,
	listPluginPackages,
	readPluginPackageAsset,
	removePluginPackage,
	setPackageEnabled
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
	/** Public provenance label: GitHub owner/repo or HTTPS origin. Updates use the private
	 * install record. Null for a hand-dropped package. */
	installedFrom: string | null;
	/** The version recorded at install time (usually equals `version` from the manifest). */
	installedVersion?: string;
	/** Capabilities of an ENABLED package held back because their stored consent no longer matches
	 * (typically after an update or an on-disk edit) — re-consent by toggling off and on. */
	pendingConsent: PendingConsent[];
};

/** A consent-gated capability that is enabled but not applied. */
export type PendingConsent = 'templates' | 'theme' | 'network';

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

const CSS_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

const parseCssConsentMap = (raw: unknown): Record<string, string> => {
	const parsed = parseConsentMap(raw);
	return Object.fromEntries(
		Object.entries(parsed).filter(([, value]) => CSS_FINGERPRINT.test(value))
	);
};

async function cssConsentFingerprint(css: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(css));
	const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
		''
	);
	return `sha256:${hex}`;
}

// SHA-256 of the exact threat-flagged stylesheet accepted per package. Keying consent by reviewed
// content (not just id) means an update cannot inherit permission for new remote URLs / overlays,
// while a maximum-size stylesheet never consumes another 256 KiB of localStorage. Legacy id arrays
// and raw-CSS map values are deliberately discarded and must earn consent again.
const trustedCssPackages = createPersistedStore<Record<string, string>>(
	'widgetsack.packages.cssTrusted',
	parseCssConsentMap
);

// Template consent per package id, keyed by a fingerprint of every capability-bearing unit across
// the package's templates (embedded pages, remote images, service-call buttons, widget CSS — see
// core/treeThreats) the user saw in the first-enable confirm. A manifest update that adds or
// changes such a unit mismatches the stored fingerprint and re-prompts.
const templateConsentPackages = createPersistedStore<Record<string, string>>(
	'widgetsack.packages.templateConsent',
	parseConsentMap
);

// Network consent per package id, keyed by the hosts FINGERPRINT (sorted hosts string) the user
// saw in the first-enable confirm. A manifest update that changes the hosts list mismatches the
// stored fingerprint, so the source stays stopped until the new hosts are re-confirmed.
const netConsentPackages = createPersistedStore<Record<string, string>>(
	'widgetsack.packages.netConsent',
	parseConsentMap
);

// Per-package install revision, bumped after every successful install/update. An update in place
// leaves the allowlist and consent maps unchanged, so without this synced key other windows would
// keep the old version's theme, templates and source until a restart.
// Stored as decimal strings so the consent-map parser validates it.
const packageRevisions = createPersistedStore<Record<string, string>>(
	'widgetsack.packages.revision',
	parseConsentMap
);

function bumpRevision(id: string): void {
	packageRevisions.update((m) => ({ ...m, [id]: String((Number(m[id]) || 0) + 1) }));
}

/** The discovered package rows, for the Plugins panel (subscribe via useStore). */
export const packagesStore = createStore<PackageRow[]>([]);

const discovered = new Map<string, Discovered>();

// Per enabled package: the capabilities applyPackage held back for missing/stale consent.
const pendingConsent = new Map<string, PendingConsent[]>();

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
		installedFrom: d.install ? installSourceLabel(d.install) : null,
		...(d.install ? { installedVersion: d.install.version } : {}),
		pendingConsent: pendingConsent.get(d.id)?.slice() ?? []
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

// Resolves false when the theme was held back for missing/stale CSS consent.
async function injectPackageTheme(d: Discovered): Promise<boolean> {
	const theme = d.manifest?.theme;
	if (!theme) return true;
	const css = await readPluginPackageAsset(d.id, theme.file);
	if (css == null) return true;
	if (
		scanCssThreats(css).length &&
		trustedCssPackages.getSnapshot()[d.id] !== (await cssConsentFingerprint(css))
	)
		return false;
	removePackageTheme(d.id);
	const el = document.createElement('style');
	el.setAttribute('data-pkg-theme', d.id);
	el.textContent = css;
	document.head.appendChild(el);
	return true;
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

function unapplyPackage(id: string): void {
	unregisterTemplates(`pkg:${id}`);
	removePackageTheme(id);
	unregisterSource(`pkg:${id}`);
	stopPackageSource(id);
	if (pendingConsent.delete(id)) publishRows();
}

// Templates carrying capability units (embedded pages, remote images, service calls, widget CSS)
// apply only when the user consented to exactly this set — togglePackage's prompt stores it, and a
// refresh/update that changes the set fails closed until the user re-consents.
function templatesConsented(m: PluginPackageManifest): boolean {
	const threats = packageTemplateThreats(m);
	return (
		!threats.length ||
		templateConsentPackages.getSnapshot()[m.id] === templateThreatFingerprint(threats)
	);
}

function netConsented(d: Discovered): boolean {
	const hosts = d.manifest?.source?.hosts;
	/* v8 ignore next -- callers only ask for consent after validating a source with declared hosts. */
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
// Mirror the enabled state to the server-side marker `package_fetch` checks. Best-effort: the
// command is studio-only (an overlay's attempt is refused and ignored) and a missing folder just
// errors — neither may break the apply. Runs on every apply (init included) so a package enabled
// before the marker existed self-heals the first time the studio applies it.
async function mirrorEnabledMarker(id: string, enabled: boolean): Promise<void> {
	try {
		await setPackageEnabled(id, enabled);
	} catch {
		/* not the studio, or the folder is gone — the marker is only advisory here */
	}
}

async function applyPackage(d: Discovered, enabled: boolean): Promise<void> {
	if (!enabled || !d.manifest) {
		unapplyPackage(d.id); // synchronous first: resetPackagesForTest relies on it (no await above)
		await mirrorEnabledMarker(d.id, false);
		return;
	}
	// Reapplication is replacement, not an additive merge. A same-id manifest that drops its theme,
	// templates, or source must not leave the previous capability alive.
	unapplyPackage(d.id);
	const pending: PendingConsent[] = [];
	if (d.manifest.templates.length) {
		if (templatesConsented(d.manifest)) {
			registerTemplates(`pkg:${d.id}`, packageTemplates(d.manifest), d.manifest.name);
		} else pending.push('templates');
	}
	// Before the source starts: its first package_fetch needs the marker on disk.
	await mirrorEnabledMarker(d.id, true);
	if (!(await injectPackageTheme(d))) pending.push('theme');
	if (d.manifest.source && !netConsented(d)) pending.push('network');
	if (pending.length) {
		pendingConsent.set(d.id, pending);
		publishRows();
	}
	if (d.manifest.source) {
		const m = d.manifest;
		registerSource({
			id: `pkg:${d.id}`,
			start: async () => () => undefined, // lifecycle owned here, not by startAllSources
			catalogEntries: () => packageCatalog(m)
		});
		// Consent-gated: a hosts list the user never confirmed (fresh enable race, manifest
		// edited on disk, update that changed hosts) keeps the loop OFF, fail-closed.
		if (hubRef && netConsented(d)) {
			runningSources.set(d.id, await startPackageSource(m, hubRef));
		}
	}
}

/**
 * (Re)discover the package directories and re-apply the enabled ones. Called at init and when
 * the Plugins panel opens (so a freshly dropped folder shows up without a restart). A package
 * that vanished from disk keeps nothing registered (its group is unregistered below).
 */
async function refreshPackagesNow(): Promise<void> {
	const files = await listPluginPackages();
	// Drop the complete previous runtime view before parsing the replacement snapshot. This is also
	// the fail-closed path for a same-id package whose new manifest is invalid or removes a capability.
	for (const d of discovered.values()) await applyPackage(d, false);
	discovered.clear();
	for (const f of files) {
		const result = f.manifest_error
			? { ok: false as const, reason: f.manifest_error }
			: parsePluginPackage(f.id, f.manifest);
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

// Refresh, toggles, and disk mutations share one queue so a delayed enable cannot restore a
// disabled package and source stop/start transitions stay strictly ordered.
let mutationTail: Promise<void> = Promise.resolve();

function enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
	const pending = mutationTail.then(run, run);
	// Keep the shared queue usable after a failed mutation; callers still receive the original rejection.
	mutationTail = pending.then(
		() => undefined,
		() => undefined
	);
	return pending;
}

export function refreshPackages(): Promise<void> {
	return enqueueMutation(refreshPackagesNow);
}

// ---- cross-window sync ---------------------------------------------------------------------------
// The studio owns package mutations; every other window (an overlay) holds its own copy of the
// persisted allowlist + consent maps, which adopt the studio's writes via `storage` events. A
// storage event only fires for ANOTHER window's write, so this window's own toggles never echo
// back here. Any such change re-scans + re-applies through the shared mutation queue (newly
// enabled packages apply; disabled/removed ones drop their templates, theme CSS, and source). A
// burst of writes (one remove touches four keys) coalesces into a single queued refresh.

const SYNC_KEYS = new Set([
	'widgetsack.packages.enabled',
	'widgetsack.packages.cssTrusted',
	'widgetsack.packages.templateConsent',
	'widgetsack.packages.netConsent',
	'widgetsack.packages.revision'
]);

let syncQueued = false;

function onStorage(event: StorageEvent): void {
	if (event.key === null || !SYNC_KEYS.has(event.key) || syncQueued) return;
	syncQueued = true;
	void enqueueMutation(() => {
		syncQueued = false;
		return refreshPackagesNow();
	}).catch((err: unknown) => console.warn('[packages] cross-window refresh failed', err));
}

let initialized = false;

/** One-shot init per window (Canvas mount, both roles — idempotent like registerBuiltinPlugins).
 * `hub` is this window's telemetry hub — package sources ingest into it (overlays poll too, so an
 * overlay-only widget bound to a package sensor works without the studio open). */
export async function initPackages(hub: TelemetryHub): Promise<void> {
	if (initialized) return;
	initialized = true;
	hubRef = hub;
	globalThis.addEventListener?.('storage', onStorage);
	await refreshPackages();
}

/**
 * Flip one package's enabled state, LIVE (templates appear in / vanish from the palette without
 * a reload; the theme style tag follows; a source's poll loop starts/stops). On the FIRST enable
 * of a package whose theme CSS scans with threats AND/OR which declares a network source,
 * `confirmEnable` is asked with a combined message stating both facts (the Plugins panel passes
 * window.confirm); declining aborts the enable. Both consents are stored — CSS by an exact-content
 * SHA-256 fingerprint, network by hosts FINGERPRINT — so changed content/hosts re-prompt while
 * unchanged packages apply on subsequent boots. Other windows re-apply live through their
 * `storage` listener (see cross-window sync above).
 */
async function togglePackageNow(
	id: string,
	enabled: boolean,
	confirmEnable: (message: string) => boolean
): Promise<void> {
	const d = discovered.get(id);
	if (!d?.manifest) return; // unknown / unparsed → not toggleable
	if (enabled) {
		let cssSummary: string | null = null;
		let approvedCssFingerprint: string | null = null;
		if (d.manifest.theme) {
			const css = await readPluginPackageAsset(id, d.manifest.theme.file);
			const threats = css ? scanCssThreats(css) : [];
			if (css && threats.length) {
				const fingerprint = await cssConsentFingerprint(css);
				if (trustedCssPackages.getSnapshot()[id] !== fingerprint) {
					cssSummary = threatSummary(threats);
					approvedCssFingerprint = fingerprint;
				}
			}
		}
		// Templates are a stranger's layout trees: state what they embed / fetch / actuate in the
		// same dialog (the iframe sandbox is already forced on at parse time).
		const templateThreats = packageTemplateThreats(d.manifest);
		const templateFp = templateThreats.length ? templateThreatFingerprint(templateThreats) : null;
		const needsTemplate =
			templateFp !== null && templateConsentPackages.getSnapshot()[id] !== templateFp;
		const source = d.manifest.source;
		const fingerprint = source ? consentFingerprint(source.hosts) : null;
		const needsNet = fingerprint !== null && netConsentPackages.getSnapshot()[id] !== fingerprint;
		if (cssSummary !== null || needsTemplate || needsNet) {
			const message = enableConsentMessage({
				...(cssSummary !== null ? { cssSummary } : {}),
				...(needsTemplate ? { templateSummary: treeThreatSummary(templateThreats) } : {}),
				...(needsNet && source ? { hosts: source.hosts, pollSeconds: source.pollSeconds } : {})
			});
			if (!confirmEnable(message)) return;
			if (approvedCssFingerprint !== null) {
				trustedCssPackages.update((m) => ({ ...m, [id]: approvedCssFingerprint }));
			}
			if (needsTemplate && templateFp !== null) {
				templateConsentPackages.update((m) => ({ ...m, [id]: templateFp }));
			}
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
async function installPackageNow(source: string): Promise<PackageOpResult> {
	let installed: { id: string };
	try {
		installed = await installPluginPackage(source);
	} catch (err) {
		return { ok: false, error: String(err) };
	}
	await refreshPackagesNow();
	bumpRevision(installed.id); // a reinstall over an enabled package must reach the overlays
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
async function updatePackageNow(id: string): Promise<PackageOpResult> {
	const d = discovered.get(id);
	if (!d?.install) return { ok: false, error: 'package was not installed from a URL' };
	if (enabledPackages.getSnapshot().includes(id)) await applyPackage(d, false);
	try {
		await installPluginPackage(reinstallSource(d.install), id);
	} catch (err) {
		await refreshPackagesNow(); // restore the (still enabled) old version's registration
		return { ok: false, error: String(err) };
	}
	await refreshPackagesNow();
	// If the update CHANGED the hosts list (or dropped the source), the stored network consent is
	// stale — drop it so the new hosts must be re-confirmed (toggle off/on). The fingerprint check
	// in applyPackage already kept the new source from starting during the refresh above.
	const next = discovered.get(id);
	const nextFp = next?.manifest?.source ? consentFingerprint(next.manifest.source.hosts) : null;
	dropStaleConsent(netConsentPackages, id, nextFp);
	// Same for template consent: a changed set of embeds / remote images / service calls must be
	// re-confirmed (applyPackage already kept the new templates unregistered during the refresh).
	const nextThreats = next?.manifest ? packageTemplateThreats(next.manifest) : [];
	dropStaleConsent(
		templateConsentPackages,
		id,
		nextThreats.length ? templateThreatFingerprint(nextThreats) : null
	);
	bumpRevision(id); // overlays re-scan and apply the new version
	return { ok: true };
}

function dropStaleConsent(
	store: typeof netConsentPackages,
	id: string,
	current: string | null
): void {
	store.update((m) => {
		if (m[id] === undefined || m[id] === current) return m;
		const rest = { ...m };
		delete rest[id];
		return rest;
	});
}

/**
 * Remove a package (works for installed AND hand-dropped folders — it's a dir delete): live-drop
 * its templates/theme, clear it from the enable allowlist AND the stored CSS consent (a future
 * re-install must re-earn trust), then delete and re-scan.
 */
async function removePackageNow(id: string): Promise<PackageOpResult> {
	const d = discovered.get(id);
	try {
		await removePluginPackage(id);
	} catch (err) {
		// The directory still exists: preserve enabled state and both approvals byte-for-byte.
		await refreshPackagesNow();
		return { ok: false, error: String(err) };
	}
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
	templateConsentPackages.update((m) => {
		if (m[id] === undefined) return m;
		const rest = { ...m };
		delete rest[id];
		return rest;
	});
	await refreshPackagesNow();
	return { ok: true };
}

/** TEST-ONLY: drop all module state so each test starts from a clean registry. */
export function resetPackagesForTest(): void {
	for (const d of discovered.values()) void applyPackage(d, false);
	runningSources.clear();
	discovered.clear();
	pendingConsent.clear();
	publishRows();
	enabledPackages.set([]);
	trustedCssPackages.set({});
	netConsentPackages.set({});
	templateConsentPackages.set({});
	packageRevisions.set({});
	hubRef = null;
	globalThis.removeEventListener?.('storage', onStorage);
	syncQueued = false;
	initialized = false;
	mutationTail = Promise.resolve();
}

export function togglePackage(
	id: string,
	enabled: boolean,
	confirmEnable: (message: string) => boolean = () => true
): Promise<void> {
	return enqueueMutation(() => togglePackageNow(id, enabled, confirmEnable));
}

export function installPackage(source: string): Promise<PackageOpResult> {
	return enqueueMutation(() => installPackageNow(source));
}

export function updatePackage(id: string): Promise<PackageOpResult> {
	return enqueueMutation(() => updatePackageNow(id));
}

export function removePackage(id: string): Promise<PackageOpResult> {
	return enqueueMutation(() => removePackageNow(id));
}
