// The plugin-package Tauri command adapter (outer ring) — every `invoke` behind a typed function,
// so the packages module shares the command-name strings and tests can mock this module. The
// read commands are dumb file I/O on the app-config `plugins/` dir (command.rs) and degrade to
// empty/null so a broken folder can never take the studio down; the remote-install commands
// PROPAGATE failures instead — the Plugins panel shows the reason to the user.

import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../bridge/contract';

/** One discovered `plugins/<id>/plugin.json`: the directory name + the raw, unparsed manifest +
 * (for packages installed from a URL) the raw `.install.json` provenance sidecar. */
export type PluginPackageFile = { id: string; manifest: string; install: string | null };

/** Every package directory with a manifest, sorted by id. [] when none / on failure. */
export async function listPluginPackages(): Promise<PluginPackageFile[]> {
	try {
		return await invoke<PluginPackageFile[]>(COMMANDS.listPluginPackages);
	} catch (err) {
		console.warn('list_plugin_packages failed', err);
		return [];
	}
}

/** The contents of `plugins/<id>/<name>` (a manifest-declared .css/.json asset), or null. */
export async function readPluginPackageAsset(id: string, name: string): Promise<string | null> {
	try {
		return await invoke<string | null>(COMMANDS.readPluginPackageAsset, { id, name });
	} catch (err) {
		console.warn('read_plugin_package_asset failed', err);
		return null;
	}
}

/** What `install_plugin_package` reports back on success. */
export type InstalledPackage = { id: string; version: string };

/** Install a package from a remote source. Updates must pass the exact installed id they intend to
 * replace; a fresh install never silently overwrites an existing package directory. */
export async function installPluginPackage(
	source: string,
	replaceId?: string
): Promise<InstalledPackage> {
	return await invoke<InstalledPackage>(COMMANDS.installPluginPackage, { source, replaceId });
}

/** What `check_plugin_package_update` reports: the sidecar's version vs the remote manifest's. */
export type PackageUpdateCheck = { current: string; latest: string; source: string };

/** Re-fetch just the manifest from the recorded install source. Throws on failure (no sidecar,
 * bad network, …) — the row shows the reason. */
export async function checkPluginPackageUpdate(id: string): Promise<PackageUpdateCheck> {
	return await invoke<PackageUpdateCheck>(COMMANDS.checkPluginPackageUpdate, { id });
}

/** Delete `plugins/<id>/` (idempotent). Throws on failure. */
export async function removePluginPackage(id: string): Promise<void> {
	await invoke(COMMANDS.removePluginPackage, { id });
}

/** What `package_fetch` hands back — the exact shape the sandbox's `transform` receives. */
export type PackageFetchResponse = { url: string; status: number; body: string };

/** Host-side fetch for a package source: the backend re-reads `plugins/<id>/plugin.json` and
 * enforces its `source.hosts` allowlist server-side (https only, no redirects, GET, 10s timeout,
 * 256 KiB cap). Throws the backend's reason — the poll loop maps failures to status 0. */
export async function packageFetch(id: string, url: string): Promise<PackageFetchResponse> {
	return await invoke<PackageFetchResponse>(COMMANDS.packageFetch, { id, url });
}
