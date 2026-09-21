// Pure domain for the app-update notice (AGENTS.md §5: no React/Tauri here). The backend's
// background checker (widgetsack/src/update.rs) publishes an `AppUpdate` — this module owns the
// wire → domain mapping and the little bits of presentation logic the About tab + nav badge share,
// so they can't drift from each other and are unit-tested without a window.

/** Result of a release check. Mirrors `AppUpdate` in widgetsack/src/command.rs (camelCased). */
export type AppUpdate = {
	current: string;
	latest: string;
	url: string;
	updateAvailable: boolean;
};

/** The serde shape on the wire (`check_app_update` / `get_app_update` / the `app_update` event). */
export type AppUpdateWire = {
	current: string;
	latest: string;
	url: string;
	update_available: boolean;
};

/** Wire → domain. `null`/`undefined` (no check has completed yet) passes through as `null`. */
export function appUpdateFromWire(wire: AppUpdateWire | null | undefined): AppUpdate | null {
	if (!wire) return null;
	return {
		current: wire.current,
		latest: wire.latest,
		url: wire.url,
		updateAvailable: wire.update_available
	};
}

/** What the nav rail's Settings item should badge: the new version tag, or nothing. */
export function updateBadge(update: AppUpdate | null): string | null {
	return update?.updateAvailable ? `v${update.latest}` : null;
}

/** The About tab's one-line status for a persisted (background or manual) result. */
export function updateStatusLine(update: AppUpdate | null): string {
	if (!update) return 'No update check has run yet.';
	return update.updateAvailable
		? `v${update.latest} available (you have v${update.current}).`
		: `You’re up to date (v${update.current}).`;
}

/** Whether `url` is one of the project's own https GitHub pages — mirrors update.rs's
 * `url_allowed` so the studio never even asks the backend to open anything else. */
export function isProjectUrl(url: string): boolean {
	const prefix = 'https://github.com/gyng/widgetsack';
	if (!url.startsWith(prefix)) return false;
	const rest = url.slice(prefix.length);
	return (rest === '' || /^[/?#]/.test(rest)) && !/[\s\p{Cc}]/u.test(url);
}
